# ASSURE-REL-01C — Released Report Consistency

**Closes:** ASSURE-PILOT-01 finding F03.

**Does not change:**

- the release record format;
- release custody (ASSURE-REL-01A);
- the manifest format or canonicalization;
- the framework and its golden digests;
- reviewer authentication;
- any HTTP route or SDK method;
- `commercialUse: restricted`;
- F04.

> The delivered document must agree with the authorization that accompanies
> it, without giving up the immutability of the approved content.

## 1. Root cause of F03

A report is frozen when it is approved. Its content (`contentDigest`), its
Markdown bytes (`markdownDigest`) and its manifest (`manifestDigest`) are bound
by the release record and by the Host's custody. Yet generator v1 wrote, at
drafting time, two statements about the report's own release:

- the READY banner of `report.md`: "**READY FOR RELEASE** — not yet released.";
- `content.integrity.release`, rendered into `report.md`: "Not released by this
  document. …".

Both were true when drafted, and stayed in the approved bytes after the
release. So a released v1 report says it is not released, next to a release
record that says it is. Those bytes cannot be corrected afterwards: changing
them breaks every digest the approval is bound to.

## 2. Semantics of DRAFT, READY and RELEASED

| State | Where it is established | What the customer sees |
| --- | --- | --- |
| **DRAFT** | `content.readiness.status` (a release check failed) | `report.md` opens with "**DRAFT — NOT FOR DELIVERY.**". It cannot be released (`ASSURANCE_ASSESSMENT_INCOMPLETE`) |
| **READY_FOR_RELEASE** | `content.readiness.status` (every check passed) | "**READY FOR RELEASE.** Every release check passed. Readiness is not release: this document does not state whether it was released. … Without one, this report is not released." This is preparation, not approval |
| **RELEASED** | **Only** a release record kept in the Host's custody (REL-01A), matching the package's digests | `release-record.json`, confirmed by `verifyCommercialRelease` → `releaseAuthenticated: true` |

No field of the report says `released`. A release record that is internally
consistent but not in custody is **not** a release: verification answers
`RELEASE_NOT_IN_CUSTODY`. When custody cannot be consulted, the package is
consistent but its release is not corroborated (`AUTHORITY_UNAVAILABLE`).

## 3. Integrity model

Nothing about the binding changes:

| Digest | Covers | Change |
| --- | --- | --- |
| `contentDigest` | canonical `report.json` | none |
| `markdownDigest` | exact bytes of `report.md` (UTF-8, LF, one trailing newline) | none |
| `manifestDigest` | the manifest, including `generatorVersion` | none |
| `releaseDigest` | the release record | none |

The report is **never edited after approval**. No banner is added, no text is
replaced, and nothing is re-digested. The bytes approved are the bytes
delivered (tested).

## 4. Decision

| Alternative | Decision | Why |
| --- | --- | --- |
| **A. Release status outside the frozen report** | **Adopted** | The release record and the custody are the only source of release status. The package presents both, and its instructions explain how to read them |
| **C. Time-invariant wording in the draft** | **Adopted, as generator v2** | The report states only what stays true before and after any release: release is established outside the document, and without a matching record confirmed by the issuer the report is not released. It claims neither release nor approval |
| B. A second, post-release rendering with its own digest | Rejected | It would be a second document with a second integrity contract and would add nothing that A + C do not. A post-release banner over approved bytes is exactly what the digests must forbid |

**Versioning.** `generatorVersion` (already in the content and the manifest)
becomes `aoc.assurance.commercial-report.v2`. The renderer chooses the READY
banner from the content's own `generatorVersion`
(`commercial-report-format.ts`), so a v1 report still re-renders to its exact
bytes. The two versions differ **only** in the READY banner, the release
statement and the version string. REP-01 proves this: today's fixture, given
the v1 wording, equals the historical v1 example byte for byte.

## 5. Content and approval

The approver approves the exact v2 `contentDigest` of a READY report.
`releaseCommercialReport` returns that draft and the kept release record,
unchanged. The report describes the assessment, and the release record
describes the authorization to deliver it. Neither is rewritten to mention the
other.

## 6. Delivery format

The delivery files are unchanged: `report.md`, `report.json`,
`integrity-manifest.json`, `release-record.json`, plus the unsigned extracts
`limitations.md` and `verification-instructions.md`. The instructions now
explain, without code:

- what each file is;
- the difference between *ready*, *released* and *authentic*;
- how to verify the digests offline;
- how to have the issuer confirm the release against its custody;
- what to do when the issuer cannot be reached;
- why a digest is not a signature.

No new file was added. In particular, there is no "release summary" that could
look authoritative without being bound to the release record.

## 7. Historical packages

- v1 packages are **never edited**. No backfill, no migration of documents, and
  no change to any `reportId`, digest, `approvedBy` or `approvedAt`.
- They verify exactly as before (`verifyCommercialReport`), and re-render byte
  for byte.
- The independent verifier recognizes them and reports their format as
  historical: their "not yet released" wording predates REL-01C, and their
  release status comes from the release record and custody.
- A v1 release kept in custody before the upgrade is still
  `RELEASE_MATCHES_AUTHORITY`.
- Its report version is **not silently reissued**. Approving today's v2
  draft under the same version is refused (`ASSURANCE_ASSESSMENT_IMMUTABLE`,
  `conflict: content`). Approving the v1 digest is refused too, because
  today's draft is v2 (`ASSURANCE_INTEGRITY_FAILED`); the v1 release is read
  back with `getCommercialRelease`. A v2 delivery of the same assessment is a
  new report version (§12).

The historical v1 example is kept in `docs/enterprise/examples/historical/`
with its original bytes.

## 8. Authoritative verification

`AssuranceService.verifyCommercialRelease` (REL-01A) is unchanged and is the
only check that establishes RELEASED. It requires integrity valid and the
release record and manifest equal to the kept ones.

## 9. Offline verification

`scripts/assurance/verify-commercial-package.mjs` still separates the
following dimensions:

- integrity;
- report, approval and assessment consistency;
- comparison with a store copy (`UNAUTHENTICATED_COPY`);
- the absence of any signature.

It now also checks that:

- the report format is known (v1 or v2); an unknown format fails;
- a v2 report states no release status of its own; the check fails even if
  every digest is recomputed.

## 10. Error scenarios

| Scenario | Result |
| --- | --- |
| DRAFT | No release, ever |
| READY, no release | `getCommercialRelease` → `null`; an unkept release record → `RELEASE_NOT_IN_CUSTODY` |
| Release record missing / altered | `releaseAuthenticated: false` (`mismatchedFields`) |
| `report.md` / `report.json` / manifest changed | The respective digest fails |
| Release banner added after approval | `markdownDigest` fails. With every digest recomputed: `RELEASE_MISMATCH` against custody |
| Custody unreachable | `AUTHORITY_UNAVAILABLE`; integrity can still be valid; nothing is authenticated |
| Another tenant | `RELEASE_NOT_IN_CUSTODY` / `ASSURANCE_ASSESSMENT_NOT_FOUND` |

## 11. Confidentiality

The new wording names no person, tenant or system. The disclosure model of
REP-01 is unchanged: deny by default, with reviewer rationale and evidence
metadata never disclosed.

## 12. Reissue

A delivered report is never edited. To deliver a corrected report, or a v2
rendering of an assessment released as v1, draft it with an incremented
`reportVersion` and release it again. The earlier version stays in custody,
unchanged.

## 13. Adversarial tests

`assure-rel-01c-released-report-consistency.test.ts` (11 tests) covers C01–C20,
C23 and C24, the verifier's format checks and determinism. C21 and C22 are
covered by the PILOT-01 suite, where F03 is inverted, not deleted, and F01 and
F02 hold. REP-01 adds the historical v1 test.

Seven mutants were killed:

- F03 back;
- v1 bytes broken;
- v1 statement kept;
- generator kept at v1;
- DRAFT given the READY banner;
- verifier accepting any format;
- verifier accepting a release claim.

## 14. Residual risks

- **Historical v1 packages keep their wording.** A customer reading only a v1
  `report.md` still sees "not yet released". The release record and the issuer
  are the answer, and a v2 reissue is a new report version.
- **A customer reading only `report.md`** learns that release is established
  elsewhere, not whether it happened.
- **No external signature.** RELEASED is shown only by asking the issuer.
- **F04.** There is no operational interface.
- **`commercialUse: restricted`** is unchanged.

## 15. Delivery procedure

1. Draft; confirm `READY_FOR_RELEASE` and read the report in full.
2. The approver releases the exact `contentDigest`, and `custody.outcome` is
   `committed`.
3. Deliver the four files and the instructions **unchanged**, as an archive.
   Never re-save `report.md`.
4. On request, verify the received package with `verifyCommercialRelease`, and
   answer with `releaseAuthenticated` and the kept approver.
