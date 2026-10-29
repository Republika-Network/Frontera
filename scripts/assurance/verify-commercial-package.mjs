// `node scripts/assurance/verify-commercial-package.mjs <package dir> [options]`
// — ASSURE-PILOT-01: independent verifier for an rn.sv commercial report
// package (report.md, report.json, integrity-manifest.json, release-record.json).
//
// Independent of the generator: it imports nothing from the Assurance code
// base, re-implements `aoc.canonical-json.v1` from its specification, hashes
// with node:crypto, reads only the package directory and holds no credential.
//
// Options, each reported as its own dimension:
//   --store-copy <file>   compare with a read-only copy of the issuer's Assurance
//                         Store: assessment consistency, and the release kept in
//                         custody (ASSURE-REL-01A). Needs better-sqlite3.
//                         `--trusted-db` is accepted as an older name.
//   --renderer <file>     full re-render of report.json compared with report.md;
//                         this one DOES load the generator's renderer and says so
//
// It distinguishes artifact integrity, report consistency (JSON <-> Markdown,
// identifiers), approval consistency, assessment consistency and release
// custody. A store file handed to this script is comparison material, not an
// authenticated authority: whoever forged a package could hand over a forged
// copy too. Authoritative verification is `AssuranceService.verifyCommercialRelease`
// against the Host's own store. External authenticity is always NOT
// DEMONSTRATED: the package carries hashes, not a signature (see
// docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md).
//
// Prints JSON. Exit 0: every performed check passed; 1: a check failed;
// 2: a required file is missing or the arguments are unusable.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error('usage: verify-commercial-package.mjs <package dir> [--store-copy <file>] [--renderer <commercial-report-markdown.js>]');
  process.exit(2);
}
const dir = resolve(argv[0]);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
};

/** The published rn.sv@0.1.0 framework digest, pinned as the verifier's own expectation. */
const RN_SV_GOLDEN_DIGEST = 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58';
const RELEASE_ROLE = 'assure.report-release';
const REQUIRED = ['report.md', 'report.json', 'integrity-manifest.json', 'release-record.json'];
const INFORMATIONAL = ['verification-instructions.md', 'limitations.md'];

// --- aoc.canonical-json.v1, re-implemented from its specification ----------
function canonical(value) {
  if (value === null || value === undefined) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object':
      break;
    default:
      throw new Error(`unsupported ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const digestOf = (value) => sha256(Buffer.from(canonical(value), 'utf8'));
const without = (object, key) => Object.fromEntries(Object.entries(object).filter(([name]) => name !== key));
/** Markdown escaping as the report renders values (backslash before Markdown/HTML metacharacters). */
const escapeMarkdown = (value) => String(value).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (match) => `\\${match}`);

/** The `limitations.md` convenience extract: a deterministic rendering of report.json `limitations`. */
function limitationsExtract(content) {
  return `# Limitations — ${content.reportId}\n\nExtracted from report.json \`limitations\`; report.json is authoritative. This file is not separately digested.\n\n${content.limitations.map((line) => `- ${line}`).join('\n')}\n`;
}

const result = {
  verifier: 'scripts/assurance/verify-commercial-package.mjs (no generator code unless --renderer)',
  files: {},
  artifactIntegrity: {},
  reportConsistency: {},
  approvalConsistency: {},
  assessmentConsistency: {},
  releaseCustody: {},
  externalAuthenticity: {},
};
const record = (section, name, ok, detail) => {
  result[section][name] = detail === undefined ? ok : { ok, detail };
  return ok;
};
const sectionPassed = (section) => Object.values(result[section]).every((value) => (typeof value === 'object' && value !== null && 'ok' in value ? value.ok : value === true));

// --- files ------------------------------------------------------------------
const present = existsSync(dir) ? readdirSync(dir).sort() : [];
for (const file of REQUIRED) record('files', file, present.includes(file));
const unexpected = present.filter((file) => !REQUIRED.includes(file) && !INFORMATIONAL.includes(file));
record('files', 'no unexpected files', unexpected.length === 0, unexpected);
if (!REQUIRED.every((file) => present.includes(file))) {
  console.log(JSON.stringify({ ...result, verdict: 'FAIL: required files missing' }, null, 2));
  process.exit(2);
}
const bytes = (file) => readFileSync(join(dir, file));
const parse = (file) => {
  try {
    return JSON.parse(bytes(file).toString('utf8'));
  } catch {
    return undefined;
  }
};
const markdownBytes = bytes('report.md');
const markdown = markdownBytes.toString('utf8');
const content = parse('report.json');
const manifest = parse('integrity-manifest.json');
const release = parse('release-record.json');
record('artifactIntegrity', 'JSON files parse', content !== undefined && manifest !== undefined && release !== undefined);

if (content && manifest && release) {
  // --- artifact integrity: unchanged since the digests were computed --------
  record('artifactIntegrity', 'report.json contentDigest', digestOf(content) === manifest.contentDigest);
  record('artifactIntegrity', 'report.md markdownDigest (exact bytes)', sha256(markdownBytes) === manifest.markdownDigest);
  record('artifactIntegrity', 'report.md is LF-only with one trailing newline', !markdown.includes('\r') && markdown.endsWith('\n') && !markdown.endsWith('\n\n'));
  record('artifactIntegrity', 'manifestDigest', digestOf(without(manifest, 'manifestDigest')) === manifest.manifestDigest);
  record('artifactIntegrity', 'releaseDigest', digestOf(without(release, 'releaseDigest')) === release.releaseDigest);
  record('artifactIntegrity', 'canonicalization version', manifest.canonicalizationVersion === 'aoc.canonical-json.v1', manifest.canonicalizationVersion);

  // --- report consistency: identifiers agree; the Markdown says what the JSON says
  const identifiers = {
    reportId: [content.reportId, manifest.reportId, release.reportId],
    assessmentId: [content.cover?.assessmentId, content.integrity?.assessmentId, manifest.assessmentId, release.assessmentId],
    assessmentDigest: [content.integrity?.assessmentDigest, manifest.assessmentDigest],
    frameworkId: [content.cover?.framework?.id, content.integrity?.frameworkId, manifest.frameworkId, 'rn.sv'],
    frameworkVersion: [content.cover?.framework?.version, content.integrity?.frameworkVersion, manifest.frameworkVersion, '0.1.0'],
    frameworkDigest: [content.integrity?.frameworkDigest, manifest.frameworkDigest, RN_SV_GOLDEN_DIGEST],
    generatorVersion: [content.integrity?.generatorVersion, manifest.generatorVersion],
    readiness: [content.readiness?.status, manifest.readiness, 'READY_FOR_RELEASE'],
  };
  for (const [name, values] of Object.entries(identifiers)) {
    record('reportConsistency', `${name} consistent`, values.every((value) => typeof value === 'string' && value === values[0]), values);
  }
  record('reportConsistency', 'reportId derives from assessmentId and version', content.reportId === `rn-sv-report:${content.cover?.assessmentId}:v${content.cover?.reportVersion}`);
  const expectedControls = Array.from({ length: 10 }, (_, index) => `SV-${String(index + 1).padStart(2, '0')}`).join();
  record('reportConsistency', 'ten controls SV-01..SV-10', Array.isArray(content.controls) && content.controls.map((control) => control.controlId).join() === expectedControls);
  const counted = { pass: 0, partial: 0, fail: 0, unknown: 0, manual_review_required: 0, not_applicable: 0 };
  for (const control of content.controls ?? []) counted[control.status] = (counted[control.status] ?? 0) + 1;
  record('reportConsistency', 'result counts match control statuses', canonical(counted) === canonical(content.results?.counts), { counted, declared: content.results?.counts });
  const missingInMarkdown = (content.controls ?? []).filter((control) => !markdown.includes(`### ${escapeMarkdown(control.controlId)} — ${escapeMarkdown(control.title)}`) || !markdown.includes(escapeMarkdown(control.statusLabel)));
  record('reportConsistency', 'every control heading and status label appears in report.md', missingInMarkdown.length === 0, missingInMarkdown.map((control) => control.controlId));
  record('reportConsistency', 'score in report.md equals report.json', markdown.includes(escapeMarkdown(String(content.results?.normalizedScore))), content.results?.normalizedScore);
  record('reportConsistency', 'report.md carries the reportId and assessmentId', markdown.includes(escapeMarkdown(content.reportId)) && markdown.includes(escapeMarkdown(content.cover?.assessmentId)));
  record('reportConsistency', 'classification shown', ['CONFIDENTIAL', 'RESTRICTED'].includes(content.cover?.confidentiality) && markdown.includes(`| Classification | ${content.cover?.confidentiality} |`), content.cover?.confidentiality);
  record('reportConsistency', 'not marked DRAFT', !markdown.includes('DRAFT — NOT FOR DELIVERY'));
  if (present.includes('limitations.md')) {
    record('reportConsistency', 'limitations.md equals a re-extraction from report.json', bytes('limitations.md').toString('utf8') === limitationsExtract(content));
  }
  const renderer = option('renderer');
  if (renderer !== undefined) {
    const { renderCommercialReportMarkdown } = await import(pathToFileURL(resolve(renderer)).href);
    record('reportConsistency', 'full re-render of report.json equals report.md (uses generator renderer)', renderCommercialReportMarkdown(content) === markdown);
  }

  // --- approval consistency: the release record approves exactly this content
  record('approvalConsistency', 'release names the manifest content/markdown/manifest digests', release.contentDigest === manifest.contentDigest && release.markdownDigest === manifest.markdownDigest && release.manifestDigest === manifest.manifestDigest);
  record('approvalConsistency', 'approver role is assure.report-release', release.approverRole === RELEASE_ROLE, release.approverRole);
  record('approvalConsistency', 'approval recorded as authenticated by an Assurance credential', release.approvalAuthentication === 'assurance_reviewer_credential');
  record('approvalConsistency', 'limitations and commercial-use restriction acknowledged', release.acknowledgements?.limitationsReviewed === true && release.acknowledgements?.commercialUseRestrictionAcknowledged === true);
  record('approvalConsistency', 'approved on or before the issue date', typeof release.approvedAt === 'string' && release.approvedAt.slice(0, 10) <= content.cover?.issuedOn, { approvedAt: release.approvedAt, issuedOn: content.cover?.issuedOn });
  record('approvalConsistency', 'approver is named', typeof release.approvedBy === 'string' && release.approvedBy.length > 0);
  record('approvalConsistency', 'commercial-use restriction recorded in the report', content.integrity?.commercialUse?.frameworkStatus === 'restricted', content.integrity?.commercialUse?.frameworkStatus);
}

// --- comparison with a copy of the issuer's store ----------------------------
const storeCopy = option('store-copy') ?? option('trusted-db');
if (storeCopy !== undefined && content && manifest) {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const db = new Database(resolve(storeCopy), { readonly: true, fileMustExist: true });
  const row = db.prepare('SELECT status, framework_id, framework_version, normalized_score, assessment_json FROM assurance_assessments WHERE assessment_id = ?').get(manifest.assessmentId);
  const custodyTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'assurance_commercial_releases'`).get() !== undefined;
  const custodyRow = custodyTable ? db.prepare('SELECT report_id, approved_by, release_digest, record_json, record_digest FROM assurance_commercial_releases WHERE report_id = ?').get(manifest.reportId) : undefined;
  db.close();

  // ASSURE-REL-01A: the release the issuer kept for this report version.
  result.storeCopy = 'UNAUTHENTICATED_COPY: a store file handed to this verifier is compared, never trusted as the authority';
  if (!custodyTable) {
    record('releaseCustody', 'release in custody', false, 'NO_CUSTODY_TABLE: this store predates release custody; the release is not corroborated');
  } else if (custodyRow === undefined) {
    record('releaseCustody', 'release in custody', false, 'NOT_IN_CUSTODY: no release is kept for this report version; the release is not corroborated');
  } else {
    record('releaseCustody', 'release in custody', true);
    let kept;
    try {
      kept = JSON.parse(custodyRow.record_json);
    } catch {
      kept = undefined;
    }
    const keptIntact = kept !== undefined && digestOf(without(kept, 'recordDigest')) === custodyRow.record_digest && kept.recordDigest === custodyRow.record_digest && kept.release?.releaseDigest === custodyRow.release_digest && kept.release?.approvedBy === custodyRow.approved_by;
    record('releaseCustody', 'custody record intact', keptIntact);
    if (kept !== undefined) {
      const differing = (prefix, delivered, stored) =>
        [...new Set([...Object.keys(delivered ?? {}), ...Object.keys(stored ?? {})])].sort().filter((key) => canonical(delivered?.[key] ?? null) !== canonical(stored?.[key] ?? null)).map((key) => `${prefix}.${key}`);
      const mismatched = [...differing('release', release, kept.release), ...differing('manifest', manifest, kept.manifest)];
      record('releaseCustody', 'delivered release record and manifest equal custody', mismatched.length === 0, mismatched);
      record('releaseCustody', 'approver as recorded in custody', release.approvedBy === kept.release?.approvedBy, { delivered: release.approvedBy, custody: kept.release?.approvedBy });
    }
  }

  if (record('assessmentConsistency', 'assessment exists in the store copy', row !== undefined)) {
    const assessment = JSON.parse(row.assessment_json);
    record('assessmentConsistency', 'status completed', row.status === 'completed' && assessment.status === 'completed', row.status);
    record('assessmentConsistency', 'assessmentDigest matches the stored assessment', assessment.integrity?.assessmentDigest === manifest.assessmentDigest);
    record('assessmentConsistency', 'framework matches', row.framework_id === manifest.frameworkId && row.framework_version === manifest.frameworkVersion);
    const differing = content.controls.filter((control) => assessment.controlEvaluations.find((evaluation) => evaluation.controlId === control.controlId)?.status !== control.status).map((control) => control.controlId);
    record('assessmentConsistency', 'every control status equals the stored evaluation', differing.length === 0, differing);
    record('assessmentConsistency', 'score equals the stored score', assessment.score?.normalizedScore === content.results.normalizedScore && row.normalized_score === content.results.normalizedScore, { stored: assessment.score?.normalizedScore, report: content.results.normalizedScore });
    const stored = assessment.findings.map((finding) => `${finding.controlId}:${finding.severity}`).sort().join();
    const reported = content.findings.map((finding) => `${finding.controlId}:${finding.severity}`).sort().join();
    record('assessmentConsistency', 'findings (control, severity) equal the stored findings', stored === reported, { stored, reported });
  }
} else {
  result.assessmentConsistency = { status: 'NOT_CHECKED: no store copy supplied' };
  result.releaseCustody = { status: 'NOT_CHECKED: no store copy supplied; the approver cannot be corroborated offline' };
}

result.externalAuthenticity = {
  status: 'NOT_DEMONSTRATED',
  reason: 'The package carries hashes only: no digital signature, no external timestamp, no anchor. Anyone who edits a file and recomputes every digest produces a package that verifies offline. The issuer keeps each release in custody (ASSURE-REL-01A): authenticity is established only by the issuer checking the package against its own store, or by comparing it with a store copy obtained over an independent, trusted channel.',
};
const sections = ['files', 'artifactIntegrity', 'reportConsistency', 'approvalConsistency', ...(storeCopy !== undefined ? ['assessmentConsistency', 'releaseCustody'] : [])];
const failedSections = sections.filter((section) => !sectionPassed(section));
result.verdict = failedSections.length === 0 ? `PASS (${sections.join(', ')}); external authenticity NOT DEMONSTRATED` : `FAIL: ${failedSections.join(', ')}`;
console.log(JSON.stringify(result, null, 2));
process.exit(failedSections.length === 0 ? 0 : 1);
