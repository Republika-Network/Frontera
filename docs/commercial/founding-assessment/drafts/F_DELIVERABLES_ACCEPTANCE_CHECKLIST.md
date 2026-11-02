# [DRAFT F] Assessment Deliverables and Acceptance Checklist

> **DRAFT.** Subject to legal review of the acceptance terms.

## Deliverables (one archive, files unchanged)

| File | Purpose | Verified by |
| --- | --- | --- |
| `report.md` | Human-readable report | `markdownDigest` |
| `report.json` | Canonical content | `contentDigest` |
| `integrity-manifest.json` | Binds assessment, framework, generator, content and Markdown digests | `manifestDigest` |
| `release-record.json` | The independent approval | Republika's custody (authoritative) |
| `limitations.md` | Extract of the limitations | Re-extraction from `report.json` |
| `verification-instructions.md` | How to verify | Informational |

## Republika pre-delivery checklist (internal)

- [ ] Readiness `READY_FOR_RELEASE`; release `custody.outcome: committed`.
- [ ] Reviewer(s) and approver are different people; the approver's
      pre-release attestation is on file.
- [ ] Scope, exclusions and limitations re-read against the SOW.
- [ ] No customer-confidential term, personal name or email in declared text,
      reviewer IDs or approver ID.
- [ ] Offline verifier PASS on files, integrity and consistency.
- [ ] Authoritative verification `RELEASE_MATCHES_AUTHORITY`.
- [ ] Cold backup taken after the release.
- [ ] Package archived with LF line endings, byte-exact.

## Customer acceptance checklist

- [ ] All six files received in one archive.
- [ ] Release digest confirmed with Republika over a second channel (Draft H).
- [ ] Offline verification passes (Draft H).
- [ ] Framework id, version and digest match the SOW.
- [ ] Scope and exclusions in the report match the SOW.
- [ ] Every control shows a result; UNKNOWN controls are understood as
      evidence gaps.
- [ ] Limitations Notice (Draft G) received and read.

## Acceptance

Acceptance is limited to **conformance of the deliverable to the SOW**
(completeness, scope, integrity). It is **not** agreement with the control
conclusions, and conclusions are not reopened at acceptance.

Deemed acceptance: [N business days] after delivery unless a conformance
defect is notified [counsel]. A conformance defect in the declared scope is
corrected by a new report version. The original stays on record.

Signed: [Customer contact] · [date]
