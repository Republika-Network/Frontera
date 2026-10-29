# Republika Sovereignty Assessment — Commercial Report (ASSURE-REP-01)

## 1. Purpose and audience

The commercial report is the customer deliverable of a **Founding
Assessment** under `rn.sv@0.1.0`. It is written for the assessed
organization's leadership and technical owners. It says what could be
demonstrated over a declared scope, what remains uncertain, and what should be
corrected.

It is **not** a certification, legal opinion, attestation of compliance or
security guarantee, and it says so. It describes one point in time.

Code: `src/enterprise/assurance/commercial-report.ts` (projection, release
checks, digests, verification) and `commercial-report-markdown.ts` (rendering).
Service: `AssuranceService.buildCommercialReportDraft` and
`releaseCommercialReport`. It has no HTTP route and no SDK method.

## 2. Inputs

| Input | Source | Trusted for |
| --- | --- | --- |
| Assessment, control results, score, domains, findings, evidence references and resolutions | the Assurance Store (stored, completed assessment) | everything the report concludes |
| Verification | `verifyAssuranceAssessment` | the `assessment_verified` check |
| Finding status and history | `listFindings`, `listFindingEvents` | current finding status; the `finding_histories_consistent` check (`findingHistoryViolations`, ASSURE-SEC-01E) |
| Manual reviews | `listManualReviews` | which reviews are authenticated (ASSURE-SEC-01B) |
| Control text, risks, limitations, revalidation criteria | the `rn.sv@0.1.0` definition | all narrative |
| **Engagement declaration**: organization and system names, description, purpose, in-scope items, exclusions, dependencies, access limitations, classification | the issuer | display and scope boundaries only. It can change no result. |
| **Issue**: `issuedOn` (YYYY-MM-DD) and `reportVersion` (e.g. `1.0`) | the issuer | cover and provenance |

The report is generated only for `rn.sv@0.1.0`
(`ASSURANCE_FRAMEWORK_VERSION_UNSUPPORTED` otherwise) and only from a
`completed` or `superseded` assessment (`ASSURANCE_ASSESSMENT_INCOMPLETE`
otherwise). `issuedOn` may not precede the evidence cutoff.

## 3. Release: DRAFT → READY_FOR_RELEASE → RELEASED

A draft is always computed, and every check is printed in it:

| Check | Passes when |
| --- | --- |
| `scope_declared` | every required declaration is present and cleared for disclosure |
| `assessment_completed` | the assessment is `completed` (a `superseded` one is not current) |
| `framework_exact` | the definition's digest is the published `rn.sv@0.1.0` digest |
| `assessment_verified` | assessment verification is valid |
| `finding_histories_consistent` | every finding of the assessment is stored and has a complete, intact history |
| `control_coverage` | exactly the ten SV controls were evaluated |
| `human_review_authenticated` | every control was concluded by an authenticated review (unauthenticated historical reviews count for nothing) |
| `rejected_evidence_not_presented_as_verified` | no rejected or supplier-provided reference reads as Host-verified |
| `disclosure_policy` | all declared text was cleared |

- **DRAFT:** at least one check failed. The Markdown opens with **DRAFT — NOT
  FOR DELIVERY**.
- **READY_FOR_RELEASE:** every check passed. It is still not released. From
  generator v2 (ASSURE-REL-01C), the Markdown says so in words that stay true
  after a release: "Readiness is not release: this document does not state
  whether it was released. … Without one, this report is not released." The
  report itself never states a release status; only the release record and
  the Host's custody do. v1 reports, whose banner says "not yet released", are
  valid and are never edited
  (`docs/security/ASSURE-REL-01C-RELEASED-REPORT-CONSISTENCY.md`).
- **RELEASED:** a release record exists. `releaseCommercialReport` issues it
  only when all of the following hold:
  1. the caller holds an authenticated Assurance reviewer credential (ASSURE-SEC-01B) with the role **`assure.report-release`**, which `assure.reviewer` does not imply, for the assessment's organization;
  2. the draft, **rebuilt from the store at that moment**, is READY_FOR_RELEASE;
  3. the approver names the exact `contentDigest` approved. Any change in between, such as a finding event, makes the digest differ and the release is refused;
  4. the approver acknowledges the limitations and the framework's recorded commercial-use restriction;
  5. the approval is not dated after `issuedOn`.

A system context, a declared identity or an `actorId` cannot release.
Generating a draft writes nothing. A release is not emitted automatically
after `completeAssessment`.

**Custody (ASSURE-REL-01A).** The release record is kept in the Assurance
Store before it is returned. A report version is released once:

- the same approver repeating the request gets the kept record back
  (`custody.outcome: 'replayed'`);
- another approver, or other content under a released version, is refused
  (`ASSURANCE_ASSESSMENT_IMMUTABLE`, `commercial_release_conflict`);
- only durable custody can release: the SQLite Assurance Store
  (ASSURE-REL-01A-R1). The in-memory store, and any store that merely claims to
  be SQLite, is refused with `ASSURANCE_STORE_UNAVAILABLE` before an approval is
  built. Drafting and verification still work on it.

`verifyCommercialRelease` checks a delivered package against that record. See
`docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md`. The delivered
record's format is unchanged. Still deliver it with the files (§7).

## 4. Disclosure model: deny by default

Every output field is built from an allowlist. Nothing is copied from an
internal object and then filtered.

- **Narrative** comes from the framework definition only: objectives,
  conclusions per result, risks, limitations, revalidation criteria and
  remediation guidance.
- **Never included:**
  - reviewer rationale;
  - evaluation summaries and finding descriptions, because they embed that rationale;
  - evidence metadata, locations (`externalId`), supplier identifiers (`evidenceReferenceId`) and provenance fields;
  - supplier verification references;
  - tenant identifiers;
  - any field of the declaration not listed in §2.
- **Evidence** appears under report-local labels (`E-01`…) with its type,
  acceptance, verification state, date and digest. A rejected reference, which
  may belong to another organization, shows no digest and no date. A supplier's
  verification claim is labelled as a claim.
- **Declared text** is untrusted. A value is **withheld**, and `scope_declared`
  and `disclosure_policy` fail, when it is too long or contains any of the
  following:
  - control or bidirectional characters;
  - `<`, `>` or a backtick;
  - a URL or an email address;
  - a credential-like word or token;
  - a long opaque string;
  - an IP address;
  - instruction-like text.

  This is a second layer. Classification never clears text merely because no
  secret pattern matched: the allowlist decides what may appear at all.
- **Markdown:** every value is escaped. Markdown and HTML metacharacters are
  backslash-escaped, newlines collapse, and no value becomes a heading, link,
  image or HTML.

The existing `INTERNAL`, `AUDITOR`, `CUSTOMER` and `PUBLIC` views
(`report.ts`) are unchanged. The commercial report takes no view parameter and
cannot be used to request them.

## 5. Interpreting results

- **Score:** 0–100 under `rn.sv.scoring@0.1.0`. It is framework-, scope- and
  methodology-bound. A high score is not demonstrated sovereignty.
- **UNKNOWN:** the reviewer could not reach a defensible conclusion from the
  evidence available. It is an **evidence gap, not a failure**. It scores zero
  and is reported apart from FAIL, with "provide evidence" as the first action.
- **FAIL:** the reviewer observed the control not satisfied. Only FAIL and
  PARTIAL carry a risk statement.
- **Blocking:** a failed SV-06 or SV-08 marks its domain unhealthy whatever
  its numeric score.
- **Findings:** the assessment's own findings, with their status as of the
  issue date. Findings a signal records after completion are counted but not
  listed.
- **Roadmap:** derived from findings only. Owner and target date are always
  `To be agreed with customer`. Nothing is invented.

## 6. Framework limitations

`rn.sv@0.1.0` performs no active testing. Its evidence is supplied by the
assessed organization, and every control is a human judgement over a sample.
The per-control limitations are printed with each control.

The framework definition, which is immutable and protected by its golden
digest, still records `commercialUse: restricted` from before ASSURE-SEC-01. A
release therefore requires the approver to acknowledge that restriction and
act as its controlled review. Lifting it formally needs a governance decision
and a new framework version.

## 7. Integrity

| Digest | Covers |
| --- | --- |
| `contentDigest` | the canonical JSON (`aoc.canonical-json.v1`) of the report content |
| `markdownDigest` | the exact UTF-8 bytes of the Markdown: LF line endings, one trailing newline. Any byte change, including CRLF conversion, changes it |
| `manifestDigest` | the manifest: assessment id and digest, framework id, version and digest, generator version, readiness, `contentDigest`, `markdownDigest` |
| `releaseDigest` | the release record: the three digests above, the approver, role, time and acknowledgements |

`verifyCommercialReport({ content, markdown, manifest, release })`
recomputes all of them and names the part that changed. That is integrity
only. `AssuranceService.verifyCommercialRelease` additionally compares the
release record and manifest with the Host's custody, which is how a forged
approver is detected (ASSURE-REL-01A).

These are integrity digests, **not a digital signature**, and they provide no
non-repudiation. They do not show that the underlying evidence is true. The
content is deterministic, so the same inputs give the same bytes; no clock or
generated id is read.

**Deliver together:** the Markdown, the JSON content, the manifest and the
release record. The Markdown alone is not a released report.

## 8. Human review

1. A reviewer (`assure.reviewer`) records an authenticated review for each control.
2. The assessment is completed.
3. A preparer drafts the report and reads the release checks and the full text.
4. An approver (`assure.report-release`) reviews the rendered report, its limitations, exclusions and commercial-use statement, and then releases it with the content digest they approved.

The approver may also be a reviewer; the release record names them.

## 9. Synthetic example

`docs/enterprise/examples/rn-sv-founding-assessment.synthetic.*` is a complete
example. It is **100% synthetic**: a fictional cooperative and platform,
synthetic evidence digests, and planted fake secrets that the tests prove are
never disclosed. It is generated by
`src/enterprise/__tests__/assurance-rep-01-commercial-report.test.ts`. The
test fails if the committed files differ from the fixture output. Regenerate
with `REP01_WRITE_EXAMPLE=1` set while running that test file. The example is
generator v2. `docs/enterprise/examples/historical/` keeps the v1 example with
its original bytes; a test proves that it still verifies, re-renders
identically, and differs from today's output only in the release wording.

## 10. Before delivery

- Readiness is READY_FOR_RELEASE, and the release record exists.
- `verifyCommercialReport` returns `valid: true` for the four delivered files,
  and `verifyCommercialRelease` returns `releaseAuthenticated: true`.
- The Host releasing it runs `persistence.provider = sqlite`; no other provider
  can release.
- The files are delivered unchanged, as an archive, with
  `verification-instructions.md`, which explains *ready*, *released* and
  *authentic* (ASSURE-REL-01C).
- Re-read the scope, exclusions and limitations against the engagement contract.
- Check that no customer-confidential term appears in the declared text.
- Deliver the files unchanged, so that no editor re-encodes the Markdown.

## 11. Correction and reissue

A delivered report is never edited.
- **Declaration error** (wrong name, missing exclusion): draft again with the
  corrected declaration and an incremented `reportVersion`, then release again.
  The previous version stays on record.
- **Changed results:** a different conclusion requires a new assessment
  (reassessment) and a new report, never an edited one.

## 12. Residual risks

- **Release custody is the issuer's own record (ASSURE-REL-01A).** It detects
  a forged approver when a package is checked against it. It is not
  non-repudiation: someone who can write the store directly and recompute
  every digest can rewrite it.
- **No digital signature or external timestamp.** The digests detect change
  but do not prove who issued the report. Offline, a package whose approver
  was changed and whose digests were recomputed still verifies.
- **Declared text** is cleared by allowlist placement plus conservative
  classification. A term that is confidential to the customer but looks
  harmless can still pass and must be checked by the approver.
- **No PDF.** A PDF must render the exact released content. Its bytes would
  need their own digest in a future version.
- **Evidence authenticity** is outside the report's reach. A supplier-provided
  artifact is identified by digest, not authenticated.
