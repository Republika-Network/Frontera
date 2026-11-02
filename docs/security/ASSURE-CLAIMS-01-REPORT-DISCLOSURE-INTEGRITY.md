# ASSURE-CLAIMS-01 — Commercial Claims Integrity and Report Disclosure Hardening

> **FINAL COMMERCIAL DECISION: NO-GO.** This is a corrective mission. It does
> not authorize commercial use, does not perform or stand in for an independent
> review, and does not decide founder decisions D-01, D-02 or D-03. Every
> customer-facing wording change below is **DRAFT, subject to qualified legal
> review** (`CUSTOMER_CLAIMS_REVIEW.md` §6, L1–L9).

| Item | Value |
| --- | --- |
| Repository / worktree | `Republika-Network/Frontera`, `C:\Users\Usuario\Republika-worktrees\ASSURE\frontera` |
| Baseline | `origin/main` = `ce457567da2c68580571d39aeff7f0d5e1768d56` (ASSURE-GOV-01, #254); no commits since |
| Branch | `fix/assure-claims-01-commercial-disclosures` |
| Framework | `rn.sv@0.1.0`, unchanged: golden digest `sha256:e71fafe1…3a58`, `commercialUse: restricted` |
| Findings resolved in text and code | GF-01, GF-06, C9 (`governance/GOVERNANCE_READINESS.md` §4, `governance/CUSTOMER_CLAIMS_REVIEW.md` §1) |
| Preserved | B7: external authenticity NOT DEMONSTRATED |

## 1. Original findings

**GF-01 (report generator).** Every report drafted by generators v1 and v2
says, in `integrity.commercialUse.statement`:

> The framework definition records commercial use as restricted pending
> controlled review. Release of this report requires an authenticated human
> approver to acknowledge that restriction and **act as that review**; the
> release record states whether this happened.

The restriction it refers to (`rn-sv-framework.ts`, `metadata.commercialUse`)
requires *controlled external review*. A Republika approver is internal. The
sentence therefore told the customer that an internal approval was the
framework's review, pre-empting the open founder decision D-02. The release
acknowledgement's doc comment (`commercial-report.ts`, `CommercialReleaseAcknowledgements`)
said the same.

**GF-06 (customer drafts).** Draft A: "an independent, evidence-based view",
"**Independent sign-off**". Draft H: "A Republika approver, independent of the
reviewers". Service specification §1: "an independent, evidence-based,
human-reviewed view". Republika authors the framework, operates the tooling,
reviews and approves, so "independent" without an axis overclaims.

**C9.** Draft A headline: "Know who can act on your behalf — **and prove it**".
The report records a reviewer's conclusions on supplied evidence; it proves
nothing to a third party.

## 2. Customer and legal risk

- Misleading-claims exposure: a buyer could rely on "independent" or "prove"
  as an assurance or attestation that does not exist (L2).
- Professional-standards exposure: presenting an internal approval as the
  framework's "controlled review" resembles an audit-style independence claim.
- Governance exposure: the report text decided D-02 by engineering default.
- Reliance exposure (B7): a customer could treat digests or issuer custody as
  independent proof of origin.

## 3. Generator versioning decision

**Decision: an additive generator version, `aoc.assurance.commercial-report.v3`.**

Why a new version rather than editing v2 in place:

1. The report is a deterministic function of its inputs (REP-01). Editing v2
   wording would make v2 produce different bytes from the same inputs, so the
   committed v2 example would stop being "v2's output", and anyone re-drafting
   to check a v2 package would get a mismatch.
2. Release replay compares a rebuilt draft against custody
   (`service.ts`, `releaseCommercialReport`, `replayOrRefuse`). Under any
   change of wording the rebuilt digest changes, so the honest description is
   a new generator identity, exactly as REL-01C did for v2.
3. The verifier already classifies reports by `generatorVersion`, and REL-01C
   established the pattern (v1 → v2).

What v3 changes — four framework-authored strings, chosen per version in
`commercial-report-format.ts` (`DISCLOSURE_WORDING_V1_V2`, `DISCLOSURE_WORDING_V3`):

| Field | v1/v2 | v3 |
| --- | --- | --- |
| `integrity.commercialUse.statement` | GF-01 wording (above) | §4 |
| `integrity.limitation` | "…integrity only. They are not a digital signature, do not provide non-repudiation, and do not authenticate the evidence." | §4 (adds: not signed; does not establish the issuer; how to corroborate) |
| last `methodology.steps` entry | "Release reviewed and approved by an authenticated human approver before delivery." | "Before delivery, release approved by a separate authenticated Republika approver holding the release role, whose credential recorded no review of this assessment. This is internal release approval, not an external review." |
| `limitations` | — | one entry added after the human-judgement entry: who performs the assessment (§4) |

What v3 does **not** change: the content shape and TypeScript types, the
schema version, the manifest format, the release record format
(`rn.sv.commercial-release.v1`) and its statement, release custody (v1/v2
records), the readiness banner (v3 uses v2's), `RELEASE_STATEMENT_V2`, the
renderer, scoring, controls, roles, authorization, the HTTP API (77
endpoints) and the SDK surface. The informational `verification-instructions.md`
is unchanged too, deliberately: it is covered by `packageDigest`, so editing
it would change the package digest of every historical re-export.

**No client-settable external-review flag exists.** Nothing in the request
(engagement, issue, release body) is read into the four strings; G01-02 proves
that an `externalReview: true` field in the engagement or the issue leaves the
content digest unchanged.

**Time invariance (REL-01C).** The v3 statement describes what release
*requires* and where approval is *recorded*; it never says this document was
approved, so it stays true for a READY draft, a DRAFT and a released report.

## 4. Corrected report language (v3, exact)

`integrity.commercialUse.statement`:

> The framework definition records commercial use of rn.sv@0.1.0 as
> restricted pending controlled external review. The control conclusions in
> this report are recorded by authenticated reviewers. Release of this report
> requires approval by a separate authorized Republika approver whose
> credential recorded none of those conclusions; that approval, where given,
> is recorded in the release record, not in this document. Internal review
> and internal release approval do not constitute an independent external
> review and do not remove the framework’s commercial-use restriction. No
> external review of this assessment is recorded. Authorizing the framework
> for commercial use is a separate governance decision; this report does not
> state that the restriction has been satisfied or lifted.

The four concepts, kept apart:

| | Concept | v3 statement |
| --- | --- | --- |
| A | Internal assessment review | "recorded by authenticated reviewers" |
| B | Internal release approval | "a separate authorized Republika approver whose credential recorded none of those conclusions" |
| C | External independent review | "No external review of this assessment is recorded." (none exists; the Host cannot record one) |
| D | Framework commercial authorization | "a separate governance decision; this report does not state that the restriction has been satisfied or lifted" |

**D-02 stays open.** The text does not say the approver *is* the controlled
review, nor that the restriction is satisfied. It is true under every D-02
outcome.

Added `limitations` entry:

> Republika authored the rn.sv framework, operates the assessment tooling, and
> performs and approves this assessment through its own authorized personnel
> or contractors. The assessment is independent of the assessed organization,
> not of the framework author or the tooling operator. No external auditor or
> independent reviewer has reviewed it.

`integrity.limitation` (B7, §8):

> The digests in the manifest show integrity only: that the content has not
> changed since it was generated. They are not a digital signature, and this
> report carries none. They do not provide non-repudiation, do not
> authenticate the evidence, and do not establish who issued the report. To
> corroborate that Republika issued it, confirm the release digest with
> Republika over a separate, trusted channel.

(The wording "They are not a digital signature, and this report carries none"
rather than "This report is not digitally signed" keeps REL-01C C24's
existing guard, which forbids the phrase "digitally signed" anywhere in a
report, unmodified.)

## 5. Historical compatibility guarantees

- `docs/enterprise/examples/historical/rn-sv-founding-assessment.synthetic.v1.*`:
  unchanged, byte for byte.
- `docs/enterprise/examples/historical/rn-sv-founding-assessment.synthetic.v2.*`
  (new): **the exact files** that were committed at
  `docs/enterprise/examples/rn-sv-founding-assessment.synthetic.*` on the
  baseline, copied unedited before the current example was regenerated as v3.
- G01-06 / G01-07 pin each historical file's sha256 and its content,
  Markdown, manifest and release digests as literals read from `origin/main`;
  today's renderer reproduces both historical Markdowns exactly.
- `commercial-report-historical.ts` (test-side) states the complete
  difference between generators. REP-01 proves that today's fixture,
  transformed to v1 or v2, **equals** the committed historical example
  (deep-equal content, identical Markdown, identical content digest), so
  "nothing else changed" is tested, not asserted.
- A v2 release kept in custody before the upgrade still authenticates, still
  exports byte-identically from custody, and is never silently reissued as v3
  (G01-09; same rule as REL-01C C13 for v1). A new report version releases
  under v3 into the same custody, with unchanged release-record fields.
- The independent verifier knows v1, v2 and v3. For v1/v2 it reports, as
  information, that the wording is historical GF-01 wording and that the
  release is internal approval, not external review. It does **not** fail
  historical packages for it: they are left as approved.

## 6. Customer-facing wording changes (before/after matrix)

Classification: 1 accurate and supported · 2 accurate only with explicit
conditions · 3 unsupported or misleading · 4 historical and immutable · 5
requires qualified legal review. Every changed item is also 5.

| Location | Before | After | Class |
| --- | --- | --- | --- |
| Draft A headline | "…and prove it" | "…and see the evidence behind it" | 3 → fixed |
| Draft A intro | "gives you an independent, evidence-based view" | "a structured, evidence-based assessment conducted by Republika reviewers" | 3 → fixed |
| Draft A bullet | "**Independent sign-off**: the person who approves your report did not review its controls." | "**Separate release approval**: a distinct authorized Republika approver, who did not perform any of the control reviews, approves your report before it is released." | 3 → fixed |
| Draft A package bullet | "confirm with us that we issued it" | adds "over a separate channel"; "It is not digitally signed." | 2 → qualified |
| Draft A (new) | — | "Who performs it" paragraph; PASS is not a guarantee of evidence authenticity | added |
| Draft A steps 4–5 | "a reviewer", "a second person" | "a Republika reviewer", "a separate Republika approver" | 2 → qualified |
| Service spec §1 | "an independent, evidence-based, human-reviewed view" | "a structured, evidence-based assessment … conducted by Republika reviewers" | 3 → fixed |
| Service spec §1 separation bullet | per-credential / per-person | adds "internal approval, not an external or independent review" | 2 → qualified |
| Service spec §1a (new) | — | framework, tooling, people, independence axis, external review, commercial authorization, meaning of PASS, boundaries, no accreditation | added |
| Service spec §7, §8 step 9, §12, §13 | "approver independently releases", "Independent approval and release", "The independent approval", "independent approval" | "a separate approver releases", "Separate release approval", "The separate internal release approval", "separate release approval" | 3 → fixed |
| Service spec §15 | — | adds: not an independent or external review; PASS not a guarantee; not digitally signed | added |
| Draft F deliverables | "The independent approval" | "The separate internal release approval (not an external review)" | 3 → fixed |
| Draft H §2 Released | "A Republika approver, independent of the reviewers, approved this exact content" | "A different authorized Republika approver approved this exact report content for release" + "Who approved it" (internal; per-credential enforcement; per-person by procedure, not cryptographically proven) | 3 → fixed |
| Draft H §4 | "the tool cannot prove who issued the package; §3 and §5 do." | "cannot establish who issued the package … not digitally signed … §3 and §5 … rely on confirmation from Republika over a separate, trusted channel" | 3 → fixed |
| Draft G item 12 | acknowledgement by the approver | adds: an internal approval step, not an external review, does not lift the restriction | 2 → qualified |
| Draft G (new) | — | "Who performs the assessment"; "What is outside scope" (ten controls by name; eight explicit exclusions) | added |
| Draft D §5 | "a reviewer cannot approve" | "a credential that recorded a review of an assessment cannot approve that assessment's release" | 2 → precise |
| Draft D §2 | "an independent controller" | unchanged (data-protection term of art) | 1, 5 |
| Draft B §4 | "keep reviewer and approver separate" | unchanged | 1 |
| Draft A/G/spec "not a certification … accreditation" | denials | unchanged | 1 |
| Report LIMITATIONS "not independently authenticated" | denial | unchanged | 1 |
| Report ACTIVITIES "Independent collection of evidence" (not performed) | denial | unchanged | 1 |
| Package `COMMERCIAL_RELEASE_PACKAGE_STATEMENT` "authenticity is established only by the issuer’s custody" | API statement | unchanged (API freeze); reads as a limit, residual R-C3 | 2 |
| `OPERATOR_ROLES.md`, `OPERATOR_RUNBOOK.md` §11 "Independent approval", "independently reads" | internal operator docs; axis = from the reviewers | unchanged (not customer-facing) | 2 |
| Report "Verified by a Host mechanism" (evidence register) | technical, Host-verified references only | unchanged | 1 |
| Historical v1/v2 reports and fixtures | GF-01 wording | unchanged | 4 |
| Host doc `AOC_ASSURANCE_COMMERCIAL_REPORT.md` §6 | "acknowledge that restriction and act as its controlled review" | acknowledgement is internal, not the controlled external review; v3 disclosure summary | 3 → fixed |

## 7. Independent-review distinction

No independent or external review of the framework, the method or any
assessment exists. R1/R2 (`governance/INDEPENDENT_REVIEW_PROTOCOL.md`) remain
PENDING, with no reviewer engaged. This mission is engineering work by an AI
agent; its tests and mutation results are not an independent review. If a
real external review is ever performed, it must be a documented engagement
whose evidence names the reviewer and scope; it must not be expressed as a
flag on a report request.

## 8. B7 disclosures

Three properties, kept distinct in the v3 report, draft H and the verifier:

| Property | Meaning | Shown by |
| --- | --- | --- |
| Integrity | the content matches its digests | the package alone (offline verifier) |
| Custody | the issuer's Host keeps a matching release record | the issuer (`verifyCommercialRelease`, `RELEASE_MATCHES_AUTHORITY`) |
| External authenticity | the origin is established without trusting the issuer | **nothing**: NOT DEMONSTRATED |

The verifier's `external authenticity NOT DEMONSTRATED` verdict and
`EXTERNAL_SIGNATURE_NOT_AVAILABLE` are unchanged. No signing was implemented.
B7 remains **OPEN**.

## 9. Regression tests

`src/enterprise/__tests__/assure-claims-01-commercial-disclosures.test.ts`
(20 tests). Text is normalised and judged per sentence (negation-aware), so
whitespace or reflow does not break it and a reintroduced claim fails
wherever it appears.

| ID | What it proves |
| --- | --- |
| G01-01 | no conflation of internal approval with controlled/external review in the v3 Markdown or authored content; the old v1/v2 sentence is caught by the same check |
| G01-01b | the independent verifier refuses a v3 package with GF-01 wording or the old limitation restored, even with every digest recomputed |
| G01-02 | A, B, C, D stated in four separate sentences; client-set `externalReview` fields have no effect; no external-review field exists |
| G01-03 | no external review, auditor or sign-off claimed in the synthetic default case |
| G01-04 | restriction visible: integrity table, statement, acknowledgement, `limitations.md` |
| G01-05 | generator v3 in content and manifest; v1/v2/v3 known; wording follows the version |
| G01-06 / G01-07 | v1 / v2 bytes and all digests equal literals pinned from `origin/main`; exact re-render |
| G01-08 | v1 and v2 packages pass the independent verifier; historical wording labelled |
| G01-09 | a kept v2 release authenticates and exports after the upgrade; never reissued; a v3 release commits and verifies |
| G01-10 | a v3 package exported (OPS-01), materialised, passes the verifier with store copy and renderer, incl. all v3 checks |
| G01-11 | after release the framework stays restricted, frozen, `0.1.0`; nothing grants commercial use |
| G01-12 | integrity vs custody vs external authenticity; no signature claimed |
| G06-01 … G06-06 | offer, service spec, handoff, notice, claims review/governance, and all customer-facing drafts |
| H01 | §10 |

Existing tests adjusted (scope: "current generator" assertions only, no
assertion weakened): REP-01 historical v1 check uses the shared transform and
gains a v2 check; REL-01C's current-generator assertions point at v3, its v1
helper uses the shared transform, and its verifier-check name follows the
version.

**Mutation testing** (each mutant applied to the built tree or the document,
the claims suite run, the file restored): 14 of 14 killed —
v3 statement reverted to GF-01 (8 tests fail), limitation loses "no digital
signature" (3), generator id back to v2 (5), who-performs limitation dropped
(2), verifier conflation check disabled (1), offer "prove it" (2), offer
"independent, evidence-based view" (2), offer "Independent sign-off" (1), spec
"independent, evidence-based" (2), handoff "independent of the reviewers" (2),
notice claims accredited certification (2), claims review misattributes GF-01
wording (1), governance decision flipped to GO (1), spec claims an
independent auditor reviewed (2).

## 10. Synthetic end-to-end validation (Phase H)

H01, against the real Enterprise Host on loopback, HTTP only, synthetic data:
`rn.sv@0.1.0`; reviewer-only mode; the Host's dedicated test organization;
synthetic evidence; ten authenticated manual reviews; a separate approver
(the reviewer is refused `403`); a v3 draft; release into durable SQLite
custody; export via OPS-01; authoritative verification
(`RELEASE_MATCHES_AUTHORITY`, `EXTERNAL_SIGNATURE_NOT_AVAILABLE`); Host
restart; re-export **byte-identical** (files and `packageDigest`);
materialisation of the six files with the operator CLI; the independent
verifier with a store copy and the renderer: `PASS (files, artifactIntegrity,
reportConsistency, approvalConsistency, assessmentConsistency,
releaseCustody); external authenticity NOT DEMONSTRATED`. It asserts no
misleading independence or certification statement, no fake external review,
the restriction visible, report and release digests consistent, and the
historical fixtures' bytes unchanged by the run. The existing REL-01D P01
pilot also passes under v3.

Local validation (2026-11-02, Windows Node 22.22.0 for SQLite suites, Linux
Node 22.23.1 for path-sensitive scripts; ≤ 590 s per command; ≤ 2 suites per
batch):

| Check | Result |
| --- | --- |
| Typecheck / build (`tsc -b`) | pass |
| CLAIMS-01 + REP-01 | 51 / 51 |
| REL-01C + REL-01A | 40 / 40 |
| REL-01D Host pilot + OPS-01 export | 9 / 9 |
| `rn.sv` framework (golden digest) + OPS-02 | 36 / 36 |
| PILOT-01 dry run + REL-01D operator interface | 41 / 41 |
| Lint (Node16 imports, architecture, public surface) | pass |
| API freeze | pass (45 frozen routes, 77 endpoints, no drift) |
| Release docs | pass (24 documents) |
| Release manifest | local mismatch on `docs/operations/AOC_ENTERPRISE_BACKUP_V1.md` only (CRLF checkout, file untouched by this branch; committed blob hashes to the manifest value) — pre-existing, recorded by GOV-01 |
| Legal check (report mode) | informational findings only, unchanged |
| Secret / PII scan of the branch diff | no credential pattern, no e-mail address |
| Framework files changed | none |

Total: 177 focused tests, 0 failures. CI results on the PR head are recorded
in the PR.

## 11. Residual risks

| ID | Residual | Owner |
| --- | --- | --- |
| R-C1 | Historical v1/v2 reports (synthetic only so far) keep the GF-01 sentence. Any real v1/v2 package already delivered would need a written correction letter, not an edit | LEG / OPS |
| R-C2 | Per-person separation of reviewer and approver is procedural; the Host enforces it per credential | OPS (`OPERATOR_ROLES.md` §4) |
| R-C3 | The export envelope's `statement` ("authenticity is established only by the issuer’s custody") is API text frozen by the API freeze; it is a limit, but could be read as a positive claim. Change only with an API mission | ENG / LEG |
| R-C4 | `verification-instructions.md` was left unchanged to keep historical package digests stable; it already says a digest is not a signature and authenticity needs the issuer | — |
| R-C5 | B7 OPEN: no signature, timestamp or anchor; origin needs the issuer | GOV (B7 options) |
| R-C6 | Wording is engineering-drafted; terms such as "assessment", "review" and "approval" may be restricted in some jurisdictions (L1) | LEG |
| R-C7 | The semantic tests detect the known claim families and close variants; a novel overclaim phrasing could pass them. Legal review remains the control | LEG |

## 12. Legal review requirements

Counsel must review, before any external use: every changed passage in §6
(L1, L2), the v3 report statements in §4 (L2, L3), the B7 corroboration
sentence (L3), draft G's scope exclusions, and whether historical v1/v2
packages require customer correction (R-C1). None of this has been reviewed.

## 13. Commercial launch-gate implications

- GF-01 and GF-06 are **IMPLEMENTED**; their technical verification is the
  test evidence above and CI on the PR head. They are not approved.
- Independent R1/R2 review: **PENDING**. Legal review: **PENDING**. Risk
  acceptance (M2, SR-12, SR-13): **PENDING**. B7: **OPEN**.
- `rn.sv@0.1.0`: commercially **restricted**, frozen. `rn.sv@0.2.0`: **not
  created**.
- All six mandatory commercial approvals (M1–M6): **missing**.
- D-01, D-02, D-03: **PENDING**, not decided here.
- G-LEGAL, G-FRAMEWORK and the final gate are unchanged.

**FINAL COMMERCIAL DECISION: NO-GO.**
