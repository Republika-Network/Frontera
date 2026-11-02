# ASSURE-OPS-01 — Customer Delivery and Security Hardening (R-02, R-04, R-05)

Status: implemented on `fix/assure-ops-01-customer-delivery-hardening`, from
`origin/main` @ `ed61e5bb` (ASSURE-REL-01E, #249). Not deployed.
**This is not a commercial authorization.** `rn.sv@0.1.0` keeps
`commercialUse: restricted`; its golden digest, `aoc.saf`, the report
generators, the historical fixtures and the offline verifier are unchanged.
The launch gate (`docs/commercial/founding-assessment/ASSURE_COMMERCIAL_GO_NO_GO.md`)
stays **NO-GO**.

This mission closes the three technical gaps that ASSURE-REL-01E named:

| Gap | Before | After |
| --- | --- | --- |
| **R-02** post-completion review mutability | A review of a `completed`, `failed` or `superseded` assessment was appended (pinned by PILOT-01 as a KNOWN LIMITATION) | Refused at the service and, atomically, at the store; nothing is recorded |
| **R-04** reviewer identifier disclosure | Any canonical string ≤ 256 characters (an email, a phone number, a path, markup) became a reviewer id and was printed verbatim in delivered reports | Configured ids must be safe public references; an unsafe historical id is withheld deterministically in new reports |
| **R-05** unsupported package export | The six delivery files were assembled only by test code (`assure-pilot-01-scenario.ts`), and custody kept no approved report bytes | A supported Host route exports the package from durable custody, verified against it; one production assembler is shared with the dry run |

## 1. Root causes

**R-02.** `AssuranceService.recordManualReview` checked identity, tenant,
role and evidence binding, but never the assessment status.
`AssuranceStore.appendManualReview` checked only tenant visibility, and in
SQLite it ran outside any transaction. Terminal immutability
(`ASSURANCE_ASSESSMENT_IMMUTABLE`) guarded assessment *content* writes, and a
review is not a content write. Effect: a late review changed no released
content, because a released report is bound by digest. But it entered the
append-only ledger of a concluded assessment, and it counted for separation
of duties. A later re-draft could therefore differ from the approved one
(REL-01D `approved_digest_stale`).

**R-04.** The reviewer id serves three purposes:

1. the internal identity (the authenticated principal);
2. the audit identity (store attribution, separation of duties, operator log);
3. the public reference printed in `content.controls[].review.reviewers`,
   `content.review.reviewers` and the release record's `approvedBy`.

These are one string. The release record must name the credential that
custody recorded, or the package could not be verified against custody. The
only validation was `isCanonicalCustomerIdentifier`: non-empty, trim-stable,
≤ 256 characters, no control characters. The report escapes Markdown, so
markup could not render, but the value itself, such as an email address, was
disclosed. No separate public alias existed.

**R-05.** REL-01A custody kept the manifest and the release record, **not**
the approved `content` and `markdown`. Re-drafting from the store is not a
faithful source. A draft also depends on the `engagement`/`issue` request
inputs, which are not stored, on finding events appended after completion,
and on the generator version in use. So an export that re-drafted could
silently deliver a report other than the one approved, or fail on a
legitimate release. The assembly of the informational files
(`limitations.md`, `verification-instructions.md`) existed only in the test
scenario.

## 2. Selected architecture

- **R-02:** a fail-closed check in two places. The service checks after
  authorization. The store checks inside the insert unit, which is the
  invariant's real home.
- **R-04:** a single pure policy module (`assurance/reviewer-reference.ts`).
  It is enforced at configuration time by the Host loader
  (`assertAssuranceReviewerConfiguration`) and by every authenticator
  (`createAssuranceReviewerAuthenticator`). Report construction applies
  deterministic withholding for historical records.
- **R-05:** **custody v2** keeps the approved artifacts inside the existing
  digested, append-only record. A pure package assembler
  (`assurance/commercial-release-package.ts`) builds the files. A service
  operation (`exportCommercialReleasePackage`) assembles them from custody and
  re-verifies them. A narrow Host route and an SDK method expose it, and a
  standalone CLI materialises the package. The response is a structured JSON
  envelope, not an archive: JSON is the Host's only response type, and base64
  per file preserves exact bytes without archive parsing risks.

Rejected alternative for R-05: re-drafting the report and checking its digests
against custody. It refuses legitimate releases when finding events or the
generator move on, and it needs request inputs that are not stored. The
store-schema DDL is unchanged. Custody v2 is a versioned record format in the
same `record_json` column (§6).

## 3. Terminal-state immutability (R-02)

**Invariant (at the store boundary, `AssuranceStore.appendManualReview`):** a
manual review appends only while its assessment is non-terminal. The terminal
statuses are `ASSURANCE_TERMINAL_STATUSES`: `completed`, `failed` (which
includes an inconclusive REL-01B termination) and `superseded`.

| Layer | Check | Atomicity |
| --- | --- | --- |
| Service (`recordManualReview`) | After credential, tenant, control and role checks; before evidence validation | None needed: an early refusal only |
| SQLite store | The visible row's status (with the supersession overlay) is read and the review inserted in one `db.transaction(...).immediate()` | The write lock is taken before the status read. Completion (`completeAssessment`), termination (`saveAssessment`) and supersession all write under `IMMEDIATE`, so a review is ordered entirely before or entirely after a transition |
| In-memory store | Status checked and review appended with no `await` between them | Single-threaded; no interleaving |

**Refusal:** `ASSURANCE_ASSESSMENT_IMMUTABLE` (HTTP `409`),
`details: { reason: 'terminal_assessment', status }`. It is an existing code
whose meaning ("this assessment's recorded content can no longer change")
covers a review. The `reason` distinguishes it from a content rewrite. No new
code was needed.

**Disclosure order.** Another organization's assessment answers
`404 ASSURANCE_ASSESSMENT_NOT_FOUND`, exactly like an unknown one. A
credential without the control's role, a wrong declared role, a declared
`reviewerId`, an organization context and the system context are all refused
`403` **before** the status is consulted. Only an authorized reviewer of the
same organization learns that the assessment is terminal. The terminal status
also takes precedence over evidence validation, so an unsupported `pass` on a
completed assessment is answered as terminal, not as unsupported.

**Historical data.** No review row is deleted or changed. Completed
assessments, their digests and their release records are untouched, and they
still verify (R02-02, R02-09).

## 4. Reviewer identity and privacy policy (R-04)

**Safe public reviewer reference** (`reviewerReferenceViolation`):

- 1–64 characters;
- lower-case ASCII letters and digits, optionally joined by single `.`, `_`
  or `-`, starting and ending with a letter or digit;
- no run of ≥ 7 digits, even across single separators (telephone-number-like);
- not starting with the reserved `withheld-reviewer-` prefix.

This excludes `@`, `+`, `:`, `/`, `\`, whitespace, newlines and control
characters, markup and Markdown syntax, non-ASCII look-alikes, and
upper/lower-case twins.

| Where | Effect |
| --- | --- |
| Host loader (`assertAssuranceReviewerConfiguration`) | Boot refused with a message that names the field and the rule, never the value |
| Every `createAssuranceReviewerAuthenticator` | Throws `ASSURANCE_VALIDATION_ERROR` for an unsafe id or a duplicate id; covers in-process embedders |
| `buildCommercialReportRelease` | Refuses an unsafe `approvedBy` (defence in depth; unreachable through a configured authenticator) |
| Report content (`controls[].review.reviewers`, `review.reviewers`) | `publicReviewerReference(id)`: a safe id unchanged, an unsafe one as `withheld-reviewer-<first 16 hex of sha256(id)>` |

**Guarantees.**

- Identity stays credential-bound (SEC-01B). Request-body identity is still
  refused.
- Nothing is silently substituted. A *configured* unsafe id is refused, never
  rewritten.
- The withheld alias applies only to reviews already stored. It is
  deterministic, so the same id always renders the same way. It keeps
  distinct ids distinct, barring a 64-bit collision, so no two reviewers merge
  into one. It never contains the original. The stored review keeps the
  original id, so audit attribution and separation of duties are unaffected.
- Historical integrity is preserved. A released report is never re-rendered:
  its approved bytes are what custody (v2) or the delivered package (v1)
  holds. The committed v1 and v2 example packages verify byte for byte
  (R04-06), and REP-01's fixture equality test is unchanged.

**What the policy cannot decide.** Whether a well-formed token such as
`jane.doe` is a person's name. That stays procedural: issue role-style
references such as `rn-reviewer-01` (`docs/commercial/founding-assessment/OPERATOR_ROLES.md`).

**Configuration impact.** A deployment whose `assuranceReviewers` contains an
id that is now unsafe refuses to boot until the id is changed. A changed id is
a new identity: past reviews and releases keep the old one, and
`approverCurrentlyAuthorized` reports `false` for releases approved under it.

## 5. Customer package format (R-05)

The established six-file package, verified against the current pipeline and
the verifier's `REQUIRED`/`INFORMATIONAL` sets:

| File | Bytes | Binding |
| --- | --- | --- |
| `report.md` | the approved Markdown, UTF-8, exactly (LF) | **integrity-bound**: `markdownDigest` covers these bytes |
| `report.json` | `JSON.stringify(content, null, 2)` + LF | **integrity-bound**: `contentDigest` covers the canonical JSON of the value |
| `integrity-manifest.json` | `JSON.stringify(manifest, null, 2)` + LF | **integrity-bound**: `manifestDigest` |
| `release-record.json` | `JSON.stringify(release, null, 2)` + LF | **integrity-bound**: `releaseDigest`, and equal to custody |
| `limitations.md` | the limitations extract | **informational**: no digest; the verifier re-extracts and compares it |
| `verification-instructions.md` | fixed text | **informational**: no digest |

The export envelope (`CommercialReleasePackageExport`) contains:

- `packageVersion` (`aoc.assurance.commercial-release-package.v1`);
- `directory` (`founding-assessment`);
- `reportId` and `assessmentId`;
- `packageDigest`: the canonical digest of each file's path, binding, size and
  sha256;
- `files[]`: `{ path, mediaType, binding, size, sha256, contentBase64 }`, in
  fixed sorted order;
- `authority`: status, `releaseDigest`, approver, `approvedAt` and
  `approverCurrentlyAuthorized`;
- `externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE'`;
- a statement naming which files are informational.

REL-01E's drafts F and H list the same six files; they were accurate.

## 6. Integrity and custody model

- **Custody v2** (`aoc.assurance.commercial-release-custody.v2`) is v1 plus
  `artifacts: { content, markdown }`, written at release from the exact draft
  the approver approved. `recordDigest` covers it, and the append-only
  triggers protect it. Every read checks, through the shared
  `commercialReleaseCustodyViolations`:
  - the record digest, the columns and the version;
  - for v2, that `verifyCommercialReport({ content, markdown, manifest, release })`
    is valid, which is the REP-01/REL-01C verification, not a second
    definition, and that the content names the record's `reportId`.
- **Same table, no DDL change, no migration.** v1 records stay valid and
  verifiable. A v1 record carrying artifacts, or a v2 record without them, is
  a violation.
- **Export** (`exportCommercialReleasePackage`):
  1. authenticate the reviewer credential and its roles;
  2. require durable custody;
  3. read the release in the credential's own tenant scope, where the store
     verifies it;
  4. require v2;
  5. assemble the six files;
  6. bound the total size;
  7. parse the assembled bytes back exactly as a recipient would and verify
     them against the record with `verifyCommercialReleaseAgainstCustody`,
     the function the verify route uses, plus a byte comparison of
     `report.md`;
  8. return only on `releaseAuthenticated: true`.

  It writes nothing, regenerates no timestamp, approval or id, and accepts no
  client-provided content.
- **Downgrade.** A runtime older than this one reads a v2 record as an
  unknown custody version, which is an integrity refusal and fails closed.

## 7. Export authorization

| Credential | Review | Release | Export | Verify |
| --- | --- | --- | --- | --- |
| Reviewer credential, `assure.reviewer` | ✅ (non-terminal only) | 403 | ✅ | ✅ |
| Reviewer credential, `assure.report-release` | 403 | ✅ (separation of duties) | ✅ | ✅ |
| Reviewer credential, other roles only (e.g. `assure.preparer`) | 403 | 403 | 403 (service) | n/a over HTTP (401 at the route) |
| Organization API key, unscoped key, CTRL-02 operator or administrator, auditor, unknown token, no token | 401 | 401 | 401 | 401 |
| System context (in process) | 403 | 403 | 403 | n/a |

Tenant scope comes from the credential. Another organization's release
answers `404 ASSURANCE_RELEASE_NOT_FOUND`, identically to an unknown one.
Every response, including errors, carries `Cache-Control: no-store`. The
audit line is `enterprise.assurance.operator` with `operation: assurance.package`
(ids and codes only).

## 8. Operational procedure

```bash
# 1. Export (reviewer or approver credential), over the private network:
curl -sS -H "Authorization: Bearer $REVIEWER_CREDENTIAL" \
  "$HOST/api/assurance/commercial-releases/$REPORT_ID/package" > export.json
#    or: client.exportCommercialReleasePackage(reportId) with the Enterprise Host SDK
# 2. Materialise: closed file set, exact bytes, refuses a non-empty directory
node scripts/assurance/materialize-commercial-package.mjs export.json --out ./founding-assessment
# 3. Verify independently before delivery
node scripts/assurance/verify-commercial-package.mjs ./founding-assessment
# 4. Archive the directory unchanged and deliver; confirm releaseDigest over a second channel
```

`export.json` contains the full report. Treat it as customer-confidential and
delete it after materialisation. See
`docs/commercial/founding-assessment/OPERATOR_RUNBOOK.md` §13.

## 9. Independent verification

The materialised package passes
`scripts/assurance/verify-commercial-package.mjs`, which was not modified,
offline and with `--store-copy` and `--renderer`:

```text
PASS (files, artifactIntegrity, reportConsistency, approvalConsistency,
assessmentConsistency, releaseCustody); external authenticity NOT DEMONSTRATED
```

A tampered `report.json`, `report.md`, `integrity-manifest.json` or
`release-record.json` is refused by the verifier and by the Host's
`verify` route. A store copy is reported as `UNAUTHENTICATED_COPY`: it is
comparison material, never the authority.

## 10. Failure behaviour

| Condition | Answer |
| --- | --- |
| Review of a terminal assessment | `409 ASSURANCE_ASSESSMENT_IMMUTABLE`, `reason: terminal_assessment`; nothing recorded |
| Unsafe or duplicate reviewer id in configuration | Boot refused (`AssuranceReviewerConfigurationError` / `ASSURANCE_VALIDATION_ERROR`), value not echoed |
| Export: no or wrong credential | `401` (route) / `403` (role) |
| Export: unknown or foreign `reportId` | `404 ASSURANCE_RELEASE_NOT_FOUND` |
| Export: release kept before ASSURE-OPS-01 | `409 ASSURANCE_RELEASE_NOT_EXPORTABLE`, `reason: artifacts_not_in_custody`. Re-deliver the package delivered at the time and verify it with `POST …/verify`, or release a new report version |
| Export: package over 4 MiB | `409 ASSURANCE_RELEASE_NOT_EXPORTABLE`, `reason: package_too_large`; nothing returned |
| Export: custody row altered outside the store | `500 ASSURANCE_INTEGRITY_FAILED`; no report content in the body. Stop delivering from that store (REL-01A §18) |
| Export: in-memory store or closed store | `503 ASSURANCE_STORE_UNAVAILABLE` |
| Materialiser: traversal, foreign name, duplicate, missing file, bad base64, digest or size mismatch, oversize, non-empty output | Exit 1; nothing written |

## 11. Historical compatibility

- `rn.sv@0.1.0` and `aoc.saf` golden digests are unchanged
  (`assurance-rn-sv-framework.test.ts`, REP-01, REL-01C).
- Generators v1/v2, the renderer, the REP-01 synthetic examples and the
  historical v1 fixture are unchanged and verify byte for byte.
- REL-01A custody v1 records are readable and verifiable unchanged, and their
  migration tests pass. The REL-01A A10 known limitation is unchanged.
- REL-01B: a review after termination was refused as unsupported before; it is
  now refused as terminal. The test was updated to the stricter code.
- PILOT-01: the late-review KNOWN LIMITATION test is inverted to RESOLVED, not
  deleted. The dry run now writes its package with the production assembler.
  Only the informational instructions text changed: the synthetic notice is
  kept, and binding labels were added.
- API: one additive route (76 → 77), one additive error code, one additive SDK
  method. No existing route, field or status changed meaning. A review of a
  terminal assessment now gets `409` where it used to get `201`.

## 12. Adversarial test evidence

Synthetic data only. Suites (compiled, run with `node --test`):

| Suite | Tests | Covers |
| --- | --- | --- |
| `assure-ops-01-terminal-review.test.ts` | 9 | R02-01 … R02-09: before terminal (incl. two concurrent reviews), completed, repeated late reviews with no rows or events, failed/terminated, superseded, a **race on two SQLite connections** in which the service had read a non-terminal status and the store refused, the reverse order, cross-tenant/unknown/role-less/wrong-role/system/declared-identity refusals, direct store appends (SQLite and in memory), historical reviews intact, restart |
| `assure-ops-01-reviewer-privacy.test.ts` | 23 | R04-01 … R04-07: valid opaque ids; email, phone (3 forms), newline, control character, HTML, Markdown link, relative and absolute paths, a Unicode confusable, an upper-case twin, a space, excessive length, the reserved prefix, empty, duplicates (policy, authenticator, Host loader, value never echoed); alias determinism and distinctness; a release record refuses an unsafe approver; an email-like historical review is withheld in JSON and Markdown and kept in the store; v1/v2 example packages verify |
| `assure-ops-01-customer-export.test.ts` | 8 | R05-01 … R05-14: exact bytes, bindings, determinism, read-only custody; system, organization, role-less, foreign and unknown callers; altered content, Markdown, manifest or release with stale and recomputed record digests (export and custody read both refuse); restart; materialise CLI plus verifier CLI PASS, four tampered files refused by the verifier and the Host; store unavailable; oversize; v1 not exportable but verifiable; traversal and other hostile envelopes refused by module and CLI; **A10 KNOWN LIMITATION** pinned for export |
| `assure-rel-01d-host-pilot.test.ts` (extended) | 1 | Over HTTP on the production-posture Host: late review `409`; export by approver and reviewer, `no-store`; `401` for no token, organization key, CTRL-02 administrator, unknown token; `404` unknown; restart, byte-identical re-export; CLI materialisation; independent verifier PASS; an altered custody row gives `500 ASSURANCE_INTEGRITY_FAILED` with no report content; no secret in the logs |

**Mutation testing** (applied to compiled code one at a time, the named suite
run, the file restored):

| # | Mutant | Result |
| --- | --- | --- |
| M01 | Skip the service terminal check | Killed (R02-02: terminal precedes evidence validation) |
| M02 | Remove the SQLite store guard | Killed (R02-04, R02-05 race, R02-08) |
| M03 | SQLite review insert in a deferred, not `IMMEDIATE`, transaction | **Survived — equivalent in process.** With the synchronous driver a deferred transaction reads the committed state inside the transaction. Across processes, WAL mode gives `SQLITE_BUSY_SNAPSHOT` instead of waiting, which is still no late review (same finding as REL-01B §14) |
| M04 | Remove the in-memory store guard | Killed (R02-08) |
| M05 | Accept every reviewer id | Killed (R04-02 …) |
| M06 | Authenticator skips the policy | Killed (R04-02 …) |
| M07 | Report prints raw reviewer ids | Killed (R04-07) |
| M08 | Accept a request-body `reviewerId` | Killed (R02-06) |
| M09 | Skip the export-time verification (alone) | **Survived — redundant layer.** Every durable store the export accepts (`providesDurableReleaseCustody` admits only factory instances) already refuses an inconsistent record on read. Kept as defence in depth for future stores |
| M10 | Skip the custody artifact check (alone) | Killed (the custody read refuses altered artifacts) |
| M11 | Skip both | Killed (R05-05) |
| M12 | Export in the system scope (cross-tenant) | Killed (R05-03) |
| M13 | Export without the role check | Killed (R05-02) |
| M14 | No package size bound | Killed (R05-13) |
| M15 | Export re-encoded (CRLF) `report.md` instead of the approved bytes | Killed (R05-01, R05-09, R05-13) |
| M16 | Drop `no-store` on operator responses | Killed (Host pilot) |
| M17 | CLI materialiser accepts any file name | Killed (R05-14) |
| M18 | Module materialiser accepts any file name | Killed (R05-14) |

16 killed, 2 survivors, both justified as equivalent or redundant.

## 13. Residual risks

| Risk | Status |
| --- | --- |
| **B7: no external signature or timestamp** | Unchanged. The export states `EXTERNAL_SIGNATURE_NOT_AVAILABLE`; authenticity is the issuer's custody |
| **A10: issuer-controlled custody** | Unchanged and pinned for export. A writer who can rewrite the store file and recompute every digest coherently has the forgery exported as `RELEASE_MATCHES_AUTHORITY` |
| Static bearer reviewer credentials; credential ≠ person; no MFA or rate limiting | Unchanged (REL-01D §10) |
| Personal names in well-formed tokens | Not detectable; procedural |
| `export.json` holds the full report in base64 | Customer-confidential; operator deletes it after materialisation (procedural) |
| Releases kept before this mission (v1) cannot be exported | By design; re-deliver the original package or release a new version |
| Custody v2 records are unreadable by older runtimes | Fail closed (integrity refusal) |
| Encryption at rest, retention, deletion, legal review, framework authorization | Unchanged; not addressed by this mission |
| The portability tooling resolves paths with `new URL(...).pathname`, which breaks under Windows Node (`C:\C:\…`) | Pre-existing, environment-only; CI (Linux) runs those suites. Not changed here |

## 14. Deployment limitations

- Nothing is deployed and no data is migrated. The first release made by this
  build is kept as custody v2. Earlier releases stay v1.
- Before upgrading a Host whose `assuranceReviewers` contains an unsafe id,
  change the id. The Host otherwise refuses to boot.
- The private-network rules of REL-01D §9 apply to the export route unchanged.

## 15. Commercial-readiness implications

R-02, R-04 and R-05 are technically closed with the evidence above.
G-TECH's specific gaps for these items are closed. G-TECH stays
**CONDITIONAL** because of B7, A10 and static credentials, which still need
acceptance (M2). Nothing here addresses operational, information-governance,
legal, framework or customer readiness. The final commercial decision stays
**NO-GO**.
