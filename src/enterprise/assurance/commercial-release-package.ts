import { createHash } from 'node:crypto';

import { computeDigest } from '../governance-store/digest.js';
import type { CommercialReportContent, CommercialReportManifest, CommercialReportRelease } from './commercial-report.js';

/**
 * The customer delivery package of a released commercial report
 * (ASSURE-OPS-01, R-05).
 *
 * Before this module the six delivery files were assembled only by the
 * PILOT-01 test scenario. This is now the one assembler, shared by the Host's
 * export operation and by the synthetic pilot, so what is tested is what is
 * delivered. It is pure: it receives the approved artifacts (the content and
 * Markdown kept in release custody, ASSURE-REL-01A custody v2) and the release
 * record and manifest exactly as kept, and serialises them. It composes no
 * report and regenerates no timestamp, approval or identifier.
 *
 * Bytes:
 *
 * | File | Bytes | Binding |
 * | --- | --- | --- |
 * | `report.md` | the approved Markdown, UTF-8, unchanged | integrity-bound: `markdownDigest` is over these exact bytes |
 * | `report.json` | `JSON.stringify(content, null, 2)` + LF | integrity-bound: `contentDigest` is over the canonical JSON of the parsed value, so whitespace is not significant |
 * | `integrity-manifest.json` | `JSON.stringify(manifest, null, 2)` + LF | integrity-bound: `manifestDigest` |
 * | `release-record.json` | `JSON.stringify(release, null, 2)` + LF | integrity-bound: `releaseDigest`, and equal to the issuer's custody |
 * | `limitations.md` | an extract of `content.limitations` | informational: covered by no digest; the verifier re-extracts and compares it |
 * | `verification-instructions.md` | fixed text | informational: covered by no digest |
 *
 * The informational files are labelled as such in the export envelope and in
 * the instructions themselves. Neither is part of what the approver approved.
 */

export const COMMERCIAL_RELEASE_PACKAGE_VERSION = 'aoc.assurance.commercial-release-package.v1';
/** The directory a materialised package is written into. */
export const COMMERCIAL_RELEASE_PACKAGE_DIRECTORY = 'founding-assessment';
/** Upper bound of the package's raw bytes (all six files). An export over it is refused, not truncated. */
export const COMMERCIAL_RELEASE_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;

export type CommercialReleasePackageFileBinding = 'integrity-bound' | 'informational';

/** The closed set of file names, in the deterministic order they are exported. No other name is ever produced or accepted. */
export const COMMERCIAL_RELEASE_PACKAGE_FILES = [
  'integrity-manifest.json',
  'limitations.md',
  'release-record.json',
  'report.json',
  'report.md',
  'verification-instructions.md',
] as const;
export type CommercialReleasePackageFileName = (typeof COMMERCIAL_RELEASE_PACKAGE_FILES)[number];

const BINDING: Readonly<Record<CommercialReleasePackageFileName, CommercialReleasePackageFileBinding>> = {
  'integrity-manifest.json': 'integrity-bound',
  'limitations.md': 'informational',
  'release-record.json': 'integrity-bound',
  'report.json': 'integrity-bound',
  'report.md': 'integrity-bound',
  'verification-instructions.md': 'informational',
};

const MEDIA_TYPE: Readonly<Record<CommercialReleasePackageFileName, string>> = {
  'integrity-manifest.json': 'application/json',
  'limitations.md': 'text/markdown; charset=utf-8',
  'release-record.json': 'application/json',
  'report.json': 'application/json',
  'report.md': 'text/markdown; charset=utf-8',
  'verification-instructions.md': 'text/markdown; charset=utf-8',
};

export interface CommercialReleasePackageFile {
  readonly path: CommercialReleasePackageFileName;
  readonly mediaType: string;
  readonly binding: CommercialReleasePackageFileBinding;
  /** Exact byte length. */
  readonly size: number;
  /** `sha256:<hex>` over the exact bytes (a transport check, distinct from the report's own digests). */
  readonly sha256: string;
  /** The exact bytes, base64. JSON strings would not guarantee byte identity; base64 does. */
  readonly contentBase64: string;
}

/** The approved artifacts and records a package is assembled from. */
export interface CommercialReleasePackageInput {
  readonly content: CommercialReportContent;
  readonly markdown: string;
  readonly manifest: CommercialReportManifest;
  readonly release: CommercialReportRelease;
  /**
   * Optional paragraph placed under the instructions' title, for example the
   * synthetic-data notice of a dry run. It changes only the informational
   * instructions file.
   */
  readonly notice?: string;
}

/**
 * The limitations extract. Must equal `limitationsExtract` in
 * scripts/assurance/verify-commercial-package.mjs, which regenerates and
 * compares it.
 */
export function commercialPackageLimitationsExtract(content: Pick<CommercialReportContent, 'reportId' | 'limitations'>): string {
  return `# Limitations — ${content.reportId}\n\nExtracted from report.json \`limitations\`; report.json is authoritative. This file is not separately digested.\n\n${content.limitations.map((line) => `- ${line}`).join('\n')}\n`;
}

/** The verification instructions delivered with every package. Informational: covered by no digest. */
export function commercialPackageVerificationInstructions(notice?: string): string {
  const preamble = notice !== undefined && notice.trim().length > 0 ? `${notice.trim()}\n\n` : '';
  return `# How to read and verify this report package

${preamble}This is not an audit and not a certification.

## What each file is

- report.md: the assessment, for people to read. It states the results and
  does NOT state whether it was released. Integrity-bound (markdownDigest,
  exact bytes).
- report.json: the same content, structured. It is authoritative.
  Integrity-bound (contentDigest, canonical JSON).
- integrity-manifest.json: the digests of report.json and report.md, the
  assessment and the framework. Integrity-bound (manifestDigest).
- release-record.json: the release. It records who approved this exact
  report (by its digests), when, and what they acknowledged. Integrity-bound
  (releaseDigest) and kept by the issuer in its release custody.
- limitations.md: an extract of report.json \`limitations\`, not separately digested.
- This file: informational, covered by no digest.

## Three different statements

1. Ready for release (in report.md): the report passed every release check.
   That is preparation, not approval.
2. Released (release-record.json): an authenticated approver at the issuer
   approved these digests. The issuer keeps that approval in its release
   custody. A report without a matching release record is NOT released.
3. Authentic: shown only by the issuer confirming that this release record
   matches its custody. These files alone cannot show it.

## How to verify

1. Run: node scripts/assurance/verify-commercial-package.mjs <this directory>
   It checks that the files are unchanged and agree with each other: report.md
   byte for byte (LF), report.json canonically, the manifest, and the release
   record's digests.
2. Ask the issuer to verify the package against its release custody, or
   compare the release record and manifest with the issuer over a separate,
   trusted channel.
3. If the issuer cannot be reached, the package is consistent but its
   approval is not corroborated. Do not treat it as authenticated.

A digest is not a digital signature. Anyone who edits a file and recomputes
every digest produces a package that verifies offline. Never re-save
report.md in an editor, since a CRLF conversion changes its digest.
`;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha256Bytes = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** The six files, in `COMMERCIAL_RELEASE_PACKAGE_FILES` order, as exact bytes. */
export function assembleCommercialReleasePackageFiles(input: CommercialReleasePackageInput): readonly { readonly path: CommercialReleasePackageFileName; readonly bytes: Buffer }[] {
  const text: Readonly<Record<CommercialReleasePackageFileName, string>> = {
    'integrity-manifest.json': json(input.manifest),
    'limitations.md': commercialPackageLimitationsExtract(input.content),
    'release-record.json': json(input.release),
    'report.json': json(input.content),
    'report.md': input.markdown,
    'verification-instructions.md': commercialPackageVerificationInstructions(input.notice),
  };
  return COMMERCIAL_RELEASE_PACKAGE_FILES.map((path) => ({ path, bytes: Buffer.from(text[path], 'utf8') }));
}

/** The export envelope's file entries for assembled bytes. */
export function describeCommercialReleasePackageFiles(files: readonly { readonly path: CommercialReleasePackageFileName; readonly bytes: Buffer }[]): readonly CommercialReleasePackageFile[] {
  return files.map(({ path, bytes }) => ({
    path,
    mediaType: MEDIA_TYPE[path],
    binding: BINDING[path],
    size: bytes.length,
    sha256: sha256Bytes(bytes),
    contentBase64: bytes.toString('base64'),
  }));
}

/** `sha256` over the canonical JSON of each file's path, binding, size and byte digest: one identity for the exact package. */
export function commercialReleasePackageDigest(files: readonly CommercialReleasePackageFile[]): string {
  return computeDigest(files.map(({ path, binding, size, sha256 }) => ({ path, binding, size, sha256 })));
}

/**
 * Validates an export envelope's files and returns their exact bytes, ready
 * to be written under `COMMERCIAL_RELEASE_PACKAGE_DIRECTORY`. Fails closed on
 * any name outside the closed set (so no path, traversal or duplicate can
 * reach the file system), a missing file, a size or digest that does not
 * match, or a total over the bound. It does not authenticate anything: it
 * proves only that the bytes are the ones the Host described.
 */
export function materializeCommercialReleasePackage(files: unknown): readonly { readonly path: CommercialReleasePackageFileName; readonly bytes: Buffer }[] {
  if (!Array.isArray(files)) throw new Error('The package has no file list.');
  const allowed = new Set<string>(COMMERCIAL_RELEASE_PACKAGE_FILES);
  const seen = new Set<string>();
  let total = 0;
  const out: { path: CommercialReleasePackageFileName; bytes: Buffer }[] = [];
  for (const entry of files as unknown[]) {
    const record = (entry ?? {}) as Record<string, unknown>;
    const path = record['path'];
    if (typeof path !== 'string' || !allowed.has(path)) throw new Error('The package names a file outside the closed delivery set.');
    if (seen.has(path)) throw new Error('The package names a file twice.');
    seen.add(path);
    const encoded = record['contentBase64'];
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error(`${path}: the content is not base64.`);
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    if (total > COMMERCIAL_RELEASE_PACKAGE_MAX_BYTES) throw new Error('The package exceeds the delivery size bound.');
    if (bytes.toString('base64') !== encoded) throw new Error(`${path}: the content is not canonical base64.`);
    if (record['size'] !== bytes.length || record['sha256'] !== sha256Bytes(bytes)) throw new Error(`${path}: the bytes do not match their declared size and digest.`);
    out.push({ path: path as CommercialReleasePackageFileName, bytes });
  }
  for (const name of COMMERCIAL_RELEASE_PACKAGE_FILES) if (!seen.has(name)) throw new Error(`The package is missing ${name}.`);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the Host's export operation returns: the exact package, as kept in custody, and the authority's answer for it. */
export interface CommercialReleasePackageExport {
  readonly packageVersion: typeof COMMERCIAL_RELEASE_PACKAGE_VERSION;
  /** Write the files into this directory. */
  readonly directory: typeof COMMERCIAL_RELEASE_PACKAGE_DIRECTORY;
  readonly reportId: string;
  readonly assessmentId: string;
  /** Identity of the exact package bytes (`commercialReleasePackageDigest`). Equal for every export of the same release. */
  readonly packageDigest: string;
  readonly files: readonly CommercialReleasePackageFile[];
  /** The authority's answer for these files, computed by the REL-01A verification before the export was returned. */
  readonly authority: {
    readonly status: 'RELEASE_MATCHES_AUTHORITY';
    readonly releaseAuthenticated: true;
    readonly releaseDigest: string;
    readonly approvedBy: string;
    readonly approverRole: string;
    readonly approvedAt: string;
    /** Whether that approver still holds the release role today. A later revocation does not rewrite the approval. */
    readonly approverCurrentlyAuthorized?: boolean;
  };
  /** Always: no digital signature exists that a third party could verify without asking the issuer. */
  readonly externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE';
  readonly statement: string;
}

export const COMMERCIAL_RELEASE_PACKAGE_STATEMENT =
  'Exported from the issuer’s release custody: report.json, report.md, integrity-manifest.json and release-record.json are the approved artifacts and the approval exactly as kept; limitations.md and verification-instructions.md are informational and covered by no digest. The package carries no digital signature: its authenticity is established only by the issuer’s custody.';
