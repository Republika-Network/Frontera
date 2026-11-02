import { createHash } from 'node:crypto';

import { computeDigest } from '../governance-store/digest.js';
import { renderCommercialReportMarkdown } from '../assurance/commercial-report-markdown.js';
import {
  COMMERCIAL_REPORT_GENERATOR_V1,
  COMMERCIAL_REPORT_GENERATOR_V2,
  DISCLOSURE_WORDING_V1_V2,
  DISCLOSURE_WORDING_V3,
  RELEASE_STATEMENT_V1,
  RELEASE_STATEMENT_V2,
} from '../assurance/commercial-report-format.js';
import type { CommercialReportContent, CommercialReportDraft, CommercialReportManifest } from '../assurance/commercial-report.js';

/**
 * The exact, complete difference between commercial-report generator
 * versions, as a test-side transformation (ASSURE-REL-01C, ASSURE-CLAIMS-01).
 *
 * Today's generator is v3. Given a v3 content, this returns what v1 or v2
 * produced from the same inputs: the generator identifier, the release
 * statement (v1 only) and the four review/authenticity disclosure strings.
 * Nothing else differs. REP-01 proves the result equals the committed
 * historical v1 and v2 examples byte for byte, which is what makes the claim
 * "nothing else differs" a tested fact rather than a description.
 */
export type HistoricalGenerator = typeof COMMERCIAL_REPORT_GENERATOR_V1 | typeof COMMERCIAL_REPORT_GENERATOR_V2;

export function asHistoricalContent(content: CommercialReportContent, generator: HistoricalGenerator): CommercialReportContent {
  const wording = DISCLOSURE_WORDING_V1_V2;
  const steps = content.methodology.steps;
  return {
    ...content,
    methodology: { ...content.methodology, steps: [...steps.slice(0, -1), wording.releaseApprovalStep] },
    limitations: content.limitations.filter((line) => line !== DISCLOSURE_WORDING_V3.whoPerformsLimitation),
    integrity: {
      ...content.integrity,
      generatorVersion: generator,
      commercialUse: { ...content.integrity.commercialUse, statement: wording.commercialUseStatement },
      release: generator === COMMERCIAL_REPORT_GENERATOR_V1 ? RELEASE_STATEMENT_V1 : RELEASE_STATEMENT_V2,
      limitation: wording.integrityLimitation,
    },
  };
}

const sha256 = (text: string): string => `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;

/** The whole draft (content, Markdown, manifest) as a historical generator produced it. */
export function asHistoricalDraft(draft: CommercialReportDraft, generator: HistoricalGenerator): CommercialReportDraft {
  const content = asHistoricalContent(draft.content, generator);
  const markdown = renderCommercialReportMarkdown(content);
  const { manifestDigest: _replaced, ...body } = { ...draft.manifest, generatorVersion: generator, contentDigest: computeDigest(content), markdownDigest: sha256(markdown) };
  const manifest: CommercialReportManifest = { ...body, manifestDigest: computeDigest(body) };
  return { content, markdown, manifest };
}
