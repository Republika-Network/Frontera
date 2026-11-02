/**
 * Generator versions of the commercial report and the release-status wording
 * each one renders (ASSURE-REL-01C).
 *
 * A report is frozen when it is approved: its content, Markdown and manifest
 * are bound by digest to the release record and to the Host's custody. So it
 * must not say anything about its own release that a later approval would
 * make false. Version 1 did: its READY banner said "not yet released" and its
 * integrity section "Not released by this document", which every released v1
 * report still says (ASSURE-PILOT-01, F03). Version 2 states only what is true
 * at every point: release is established outside the document, by a release
 * record whose digests match, confirmed by the issuer's custody.
 *
 * Each content carries its generator version, and the renderer chooses the
 * wording from it, so a v1 report re-renders to its original bytes. Released
 * v1 packages are never edited.
 *
 * Version 3 (ASSURE-CLAIMS-01, GF-01) corrects what v1 and v2 say about review.
 * Both told the customer that the internal release approver "act[s] as" the
 * controlled review the `rn.sv@0.1.0` commercial-use restriction requires.
 * That conflated four separate things, which v3 keeps apart:
 *
 * - A. internal assessment review: authenticated reviewers conclude controls;
 * - B. internal release approval: a separate authorized Republika approver,
 *   whose credential recorded none of those conclusions, approves the digests;
 * - C. external independent review: none is recorded -- the Host has no
 *   mechanism that could record one, and no input lets a caller claim one;
 * - D. framework commercial authorization: a separate governance decision,
 *   which follows from none of A, B or C.
 *
 * v3 also states, in the digest-bound text, that the report is not digitally
 * signed and how to corroborate its origin (B7). It changes only the wording
 * of four framework-authored strings (below); the content shape, the
 * manifest, the release record, custody and the banner are those of v2.
 * v1 and v2 reports keep their original wording and bytes.
 */

/** The first generator. Its packages remain valid and verifiable, unchanged. */
export const COMMERCIAL_REPORT_GENERATOR_V1 = 'aoc.assurance.commercial-report.v1';
/** ASSURE-REL-01C: release-status wording that no later release can contradict. */
export const COMMERCIAL_REPORT_GENERATOR_V2 = 'aoc.assurance.commercial-report.v2';
/** ASSURE-CLAIMS-01: internal review, internal release approval, external review and commercial authorization stated apart. */
export const COMMERCIAL_REPORT_GENERATOR_V3 = 'aoc.assurance.commercial-report.v3';
export const COMMERCIAL_REPORT_GENERATOR_VERSIONS: readonly string[] = [COMMERCIAL_REPORT_GENERATOR_V1, COMMERCIAL_REPORT_GENERATOR_V2, COMMERCIAL_REPORT_GENERATOR_V3];

export const DRAFT_BANNER = '> **DRAFT — NOT FOR DELIVERY.** One or more release checks failed; see “Release readiness”.';

/** v1 READY banner, kept only to re-render v1 reports exactly. */
const READY_BANNER_V1 = '> **READY FOR RELEASE** — not yet released. This document may be delivered only together with a release record whose digests match its manifest.';
/** v1 release statement, kept only so v1 content remains what it was. */
export const RELEASE_STATEMENT_V1 = 'Not released by this document. Release is a separate record that binds an authenticated human approval to this report’s digests.';

const READY_BANNER_V2 =
  '> **READY FOR RELEASE.** Every release check passed. Readiness is not release: this document does not state whether it was released. A release is established only by an accompanying release record whose digests match this report’s manifest, confirmed by the issuer’s release custody. Without one, this report is not released.';
export const RELEASE_STATEMENT_V2 =
  'This document does not record its own release. A release is a separate record, kept by the issuer, that binds an authenticated human approval to this report’s digests. Without a matching release record confirmed by the issuer, this report is not released.';

/** The banner a report renders, from its readiness and the generator version it was drafted with. v3 keeps the v2 banner. */
export function readinessBanner(readiness: string, generatorVersion: string): string {
  if (readiness !== 'READY_FOR_RELEASE') return DRAFT_BANNER;
  return generatorVersion === COMMERCIAL_REPORT_GENERATOR_V1 ? READY_BANNER_V1 : READY_BANNER_V2;
}

// ---------------------------------------------------------------------------
// Review and authenticity disclosure, per generator version (ASSURE-CLAIMS-01)
// ---------------------------------------------------------------------------

/**
 * The framework-authored strings whose wording differs between v1/v2 and v3.
 * Nothing in them is read from a request: no caller can make a report claim
 * an external review, and none is claimed.
 */
export interface CommercialReportDisclosureWording {
  /** `integrity.commercialUse.statement`. */
  readonly commercialUseStatement: string;
  /** `integrity.limitation`. */
  readonly integrityLimitation: string;
  /** The last entry of `methodology.steps`. */
  readonly releaseApprovalStep: string;
  /** An entry of `limitations` naming who performs the assessment, after `REVIEW_LIMITATION_ANCHOR`; absent before v3. */
  readonly whoPerformsLimitation?: string;
}

/** The `limitations` entry after which v3 inserts `whoPerformsLimitation`. Unchanged in every version. */
export const REVIEW_LIMITATION_ANCHOR = 'Every rn.sv control is concluded by an authenticated human reviewer; the conclusions involve professional judgement.';

/**
 * v1 and v2 wording, kept only so historical content remains what it was.
 * GF-01: its commercial-use statement says the internal approver "act[s] as"
 * the controlled review. It is superseded by v3 and never drafted again.
 */
export const DISCLOSURE_WORDING_V1_V2: CommercialReportDisclosureWording = {
  commercialUseStatement:
    'The framework definition records commercial use as restricted pending controlled review. Release of this report requires an authenticated human approver to acknowledge that restriction and act as that review; the release record states whether this happened.',
  integrityLimitation: 'The digests in the manifest show integrity only. They are not a digital signature, do not provide non-repudiation, and do not authenticate the evidence.',
  releaseApprovalStep: 'Release reviewed and approved by an authenticated human approver before delivery.',
};

/**
 * v3 wording. Time-invariant, like the v2 release statement: it describes what
 * release requires and where approval is recorded, never that this document
 * was approved, so no later release can make it false (ASSURE-REL-01C).
 */
export const DISCLOSURE_WORDING_V3: CommercialReportDisclosureWording = {
  commercialUseStatement:
    'The framework definition records commercial use of rn.sv@0.1.0 as restricted pending controlled external review. The control conclusions in this report are recorded by authenticated reviewers. Release of this report requires approval by a separate authorized Republika approver whose credential recorded none of those conclusions; that approval, where given, is recorded in the release record, not in this document. Internal review and internal release approval do not constitute an independent external review and do not remove the framework’s commercial-use restriction. No external review of this assessment is recorded. Authorizing the framework for commercial use is a separate governance decision; this report does not state that the restriction has been satisfied or lifted.',
  integrityLimitation:
    'The digests in the manifest show integrity only: that the content has not changed since it was generated. They are not a digital signature, and this report carries none. They do not provide non-repudiation, do not authenticate the evidence, and do not establish who issued the report. To corroborate that Republika issued it, confirm the release digest with Republika over a separate, trusted channel.',
  releaseApprovalStep:
    'Before delivery, release approved by a separate authenticated Republika approver holding the release role, whose credential recorded no review of this assessment. This is internal release approval, not an external review.',
  whoPerformsLimitation:
    'Republika authored the rn.sv framework, operates the assessment tooling, and performs and approves this assessment through its own authorized personnel or contractors. The assessment is independent of the assessed organization, not of the framework author or the tooling operator. No external auditor or independent reviewer has reviewed it.',
};

/** The disclosure wording of a generator version. */
export function disclosureWording(generatorVersion: string): CommercialReportDisclosureWording {
  return generatorVersion === COMMERCIAL_REPORT_GENERATOR_V3 ? DISCLOSURE_WORDING_V3 : DISCLOSURE_WORDING_V1_V2;
}
