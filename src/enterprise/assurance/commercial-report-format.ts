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
 */

/** The first generator. Its packages remain valid and verifiable, unchanged. */
export const COMMERCIAL_REPORT_GENERATOR_V1 = 'aoc.assurance.commercial-report.v1';
/** ASSURE-REL-01C: release-status wording that no later release can contradict. */
export const COMMERCIAL_REPORT_GENERATOR_V2 = 'aoc.assurance.commercial-report.v2';
export const COMMERCIAL_REPORT_GENERATOR_VERSIONS: readonly string[] = [COMMERCIAL_REPORT_GENERATOR_V1, COMMERCIAL_REPORT_GENERATOR_V2];

export const DRAFT_BANNER = '> **DRAFT — NOT FOR DELIVERY.** One or more release checks failed; see “Release readiness”.';

/** v1 READY banner, kept only to re-render v1 reports exactly. */
const READY_BANNER_V1 = '> **READY FOR RELEASE** — not yet released. This document may be delivered only together with a release record whose digests match its manifest.';
/** v1 release statement, kept only so v1 content remains what it was. */
export const RELEASE_STATEMENT_V1 = 'Not released by this document. Release is a separate record that binds an authenticated human approval to this report’s digests.';

const READY_BANNER_V2 =
  '> **READY FOR RELEASE.** Every release check passed. Readiness is not release: this document does not state whether it was released. A release is established only by an accompanying release record whose digests match this report’s manifest, confirmed by the issuer’s release custody. Without one, this report is not released.';
export const RELEASE_STATEMENT_V2 =
  'This document does not record its own release. A release is a separate record, kept by the issuer, that binds an authenticated human approval to this report’s digests. Without a matching release record confirmed by the issuer, this report is not released.';

/** The banner a report renders, from its readiness and the generator version it was drafted with. */
export function readinessBanner(readiness: string, generatorVersion: string): string {
  if (readiness !== 'READY_FOR_RELEASE') return DRAFT_BANNER;
  return generatorVersion === COMMERCIAL_REPORT_GENERATOR_V1 ? READY_BANNER_V1 : READY_BANNER_V2;
}
