# `rn.sv@0.2.0` — Candidate Specification and Migration Impact (DRAFT)

> **FINAL COMMERCIAL DECISION: NO-GO.**
>
> **STATUS: DRAFT CANDIDATE — NOT CREATED, NOT REGISTERED, NOT PUBLISHED, NOT
> ACTIVE, NOT AUTHORIZED.** No source file, golden digest, registry entry or
> configuration value for `rn.sv@0.2.0` exists. This document is the input to
> founder decision D-01 and to the R1 methodology review. Its contents may change
> before any freeze. Labels: VERIFIED · PROPOSED · PENDING · BLOCKED.

## 1. Identity (PROPOSED)

| Field | Candidate value |
| --- | --- |
| `frameworkId` | `rn.sv` (unchanged) |
| `frameworkVersion` | `0.2.0` |
| `name` | `Republika Sovereignty Assessment` (unchanged) |
| `issuer` | `republika-network` (unchanged) |
| `issuedAt` | The freeze date (R-06a) |
| `status` | `active` in the frozen object; **not opted in** until R-06b (strategy §5) |
| Golden digest | Computed once at freeze; pinned in a new test. Unknown today |

## 2. Unchanged content (PROPOSED; subject to R1 methodology review)

Byte-identical in meaning to `rn.sv@0.1.0`:

- `domains` (five; weights 0.3 / 0.2 / 0.2 / 0.2 / 0.1; blocking SV-08 and SV-06);
- `controls` SV-01…SV-10 (titles, descriptions, objectives, types,
  criticality, questions, severity mappings, `scoring`);
- `evidenceRequirements` (one per control; `external_artifact_reference`,
  `control_attestation`; organization-bound; `contradictionPolicy:
  manual_review`; no `mustBeVerified`);
- `scoringModel` (`rn.sv.scoring@0.1.0`, `unknownPolicy: 'zero'`,
  `manualReviewPolicy: 'zero'`, `blockingRule: 'domain_override'`);
- `eligibilityProfiles: []`;
- `metadata.reviewerRole`, `reviewOutcomeSemantics`, `manualReviewCondition`,
  `missingEvidenceTreatment`, `controlProfiles`, `localizedTitles`, `automation`.

The R-06a mission copies these **from the 0.1.0 source**, and a test asserts
they are deep-equal, so the "unchanged" claim is checked, not asserted.

## 3. Changed content (PROPOSED)

### 3.1 `description`

```text
Ten-control, human-reviewed assessment of an organization's digital-sovereignty
posture over a declared scope, performed by Republika on evidence supplied by
the assessed organization, which Republika does not authenticate. Results are
framework-bound, scope-bound, sample-based and point-in-time. They are not a
certification, an independent attestation, a legal opinion or a guarantee.
```

### 3.2 `metadata.commercialUse`

```text
status:     governed
statement:  Commercial use of results recorded under rn.sv 0.2.0 is permitted
            only under a valid Republika commercial authorization record for
            this exact framework digest, referenced in each release record.
            This framework definition does not itself authorize commercial use,
            and no technical change lifts or grants it.
authorizationRecordType:  rn.sv.commercial-authorization.v1
acceptedResidualsMustBeDisclosed:
  - B1  Customer-supplied evidence is identified by digest and judged by a
        reviewer; it is never authenticated.
  - B3  Reviewer and approver authenticate with static credentials;
        separation of duties is enforced per credential and, for people,
        by procedure.
  - B7  Releases carry integrity digests but no digital signature, timestamp
        or independent anchor; authenticity is confirmed by the issuer.
        [Removed only by a later version or generator that signs releases.]
  - A10 Release custody is the issuer's own record.
  - IND The assessment is performed by Republika, which also authored the
        framework and operates the tooling.
predecessorBlockers:          # disposition of each 0.1.0 blocker, by mission
  B1: residual accepted-and-disclosed (ASSURE-SEC-01C)
  B2: closed (ASSURE-SEC-01C)
  B3: residual accepted-and-disclosed (ASSURE-SEC-01B, ASSURE-REL-01D, ASSURE-OPS-01)
  B4: closed (ASSURE-SEC-01D)
  B5: closed (ASSURE-SEC-01D)
  B6: closed (ASSURE-SEC-01E)
  B7: residual accepted-and-disclosed (ASSURE-REL-01A; signing not implemented)
  B8: closed (ASSURE-SEC-01C)
  B9: closed (ASSURE-SEC-01A, ASSURE-OPS-01)
```

"accepted-and-disclosed" and "closed" here describe what a valid authorization
record must contain. **They are not true today.** If, at freeze time, any of
those acceptances does not exist in an approved record, the freeze is blocked
(§7). The frozen text describes the policy, never an approval it cannot prove.

### 3.3 `metadata.predecessor` (new)

```text
frameworkVersion: 0.1.0
frameworkDigest:  sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58
relationship:     Same controls, evidence requirements and scoring [unless R1
                  changes them]; differs in description and commercial-use
                  governance. 0.1.0 remains restricted and is never authorized.
```

## 4. Authorization record (governance; not part of the frozen bytes)

Format in [`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md) §4.
It binds `frameworkDigest`, lists accepted residuals with their register IDs
(SR-xx), conditions, permitted use, expiry and status. Its own digest is what
the release references.

## 5. Release-time behaviour required (R-06b; PROPOSED)

| # | Requirement |
| --- | --- |
| 5.1 | A release under `rn.sv@0.2.0` is refused unless the Host is configured with an authorization record (by path and pinned digest) whose `frameworkDigest` equals the definition's, whose status is `AUTHORIZED_CONDITIONAL`, and which has not expired at `approvedAt`. |
| 5.2 | The release record (new `rn.sv.commercial-release.v2`) carries `commercialAuthorization: { recordId, recordDigest }`. |
| 5.3 | The approver's acknowledgement becomes "the framework's commercial-use terms and the authorization's conditions", not "the restriction". The existing `commercialUseRestrictionAcknowledged` field stays valid for 0.1.0 releases. |
| 5.4 | The cover statement is derived per framework version (fixes GF-01 for new reports). 0.1.0 reports keep their wording. |
| 5.5 | Verification reports authorization status **now**, separately from release authenticity (strategy §6). |
| 5.6 | Configuration of the authorization record is a production-configuration change made only by OPS on an engagement Host, after GO. Not in R-06b. |

## 6. Migration impact analysis (VERIFIED coupling; PROPOSED changes)

| Component | Current coupling (file:line at `2e32eb15`) | Change needed for 0.2.0 | Risk to history |
| --- | --- | --- | --- |
| Framework source | `frameworks/rn-sv-framework.ts` (0.1.0 only) | **New file** for 0.2.0; 0.1.0 file untouched | None if 0.1.0 file is untouched (golden test proves it) |
| Golden test | `__tests__/assurance-rn-sv-framework.test.ts:30` pins 0.1.0 | New test pinning 0.2.0; 0.1.0 test unchanged; deep-equality test for §2 | None |
| Opt-in list | `configuration/enterprise-configuration.ts:482` `['rn.sv@0.1.0']` | Add `rn.sv@0.2.0` (R-06b) | None; 0.1.0 still selectable |
| Composition map | `composition/composition-root.ts:2588` `{ 'rn.sv@0.1.0': … }` | Add entry | None |
| Report gate | `assurance/commercial-report.ts:473` refuses non-0.1.0 | Accept a closed set of `(version, digest)` | Must keep refusing unknown digests |
| Readiness `framework_exact` | `commercial-report.ts:521` compares to the 0.1.0 digest | Closed map of known digests | Same |
| Control coverage | `commercial-report.ts:59,542` 0.1.0 control list | Per-version list (identical if §2 holds) | None |
| Limitation and scope texts | `commercial-report.ts:411,416,425` name `rn.sv@0.1.0` | Derived from the framework version | **Must** keep 0.1.0 wording for 0.1.0 reports: generator v3 only for new drafts |
| Cover commercial-use statement | `commercial-report.ts:787-791` fixed text | Per-version text (GF-01) | Same |
| Generator version | `COMMERCIAL_REPORT_GENERATOR_VERSION` = V2 | V3 for 0.2.0; V1/V2 kept for re-rendering | REL-01C C13 and REP-01 historical tests must stay green |
| Release record | `rn.sv.commercial-release.v1`, acknowledgement field | v2 with authorization reference (§5.2) | v1 records stay verifiable |
| Custody | `aoc.assurance.commercial-release-custody.v2` | Unchanged format; v2 records with release v2 inside | None expected; test it |
| Offline verifier | `scripts/assurance/verify-commercial-package.mjs:45-46,145-147` pins 0.1.0 | Closed digest map; authorization reference check (presence + digest; status needs the issuer) | Old packages must still PASS |
| Package materializer | `scripts/assurance/materialize-commercial-package.mjs` | Probably none; verify | — |
| API contract / freeze | `api/assurance-contract.ts:293` acknowledgement shape | Additive only; API freeze check updated in the same PR | Frozen routes unchanged |
| Lifecycle (GF-08, GF-09) | No deprecation path; deregistration breaks reads | Supported deprecation; test of deregistration behaviour | Protects historical access |
| Docs | `AOC_ASSURANCE_COMMERCIAL_REPORT.md`, REL-01A, drafts G/H | Version-aware wording | — |

**Historical artefacts that must stay byte-identical:** `docs/enterprise/examples/historical/rn-sv-founding-assessment.synthetic.v1.*`,
`docs/enterprise/examples/rn-sv-founding-assessment.synthetic.*`, the
`pre-assure-01` fixtures, and any custody store or backup. R-06 must prove this
with the existing tests unchanged.

**Assessments do not migrate.** An assessment under 0.1.0 stays under 0.1.0. A
customer moves to 0.2.0 only by a new assessment (`../SERVICE_SPECIFICATION.md` §14).

## 7. Preconditions for creating the frozen file (R-06a)

| # | Precondition | Status |
| --- | --- | --- |
| 1 | D-01 recorded: successor authorized to be **created** (not yet to be used commercially) | PENDING |
| 2 | R1 methodology review delivered on this candidate | BLOCKED (no reviewer) |
| 3 | §3.2 text approved by GOV, and by LEG for disclosure wording | PENDING |
| 4 | Decision on whether §2 stays unchanged, recorded | PENDING |

Activating commercial use additionally requires M1–M6 and the procedure in
[`COMMERCIAL_AUTHORIZATION_PROCEDURE.md`](COMMERCIAL_AUTHORIZATION_PROCEDURE.md).
