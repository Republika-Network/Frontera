import { computeDigest } from '../governance-store/digest.js';
import { COMMERCIAL_REPORT_RELEASE_ROLE, verifyCommercialReport, type CommercialReportManifest, type CommercialReportRelease, type CommercialReportVerification } from './commercial-report.js';

/**
 * Durable custody of commercial report releases (ASSURE-REL-01A).
 *
 * ASSURE-REP-01 returned a release record and kept nothing, so a package
 * whose `approvedBy` was edited and whose digests were all recomputed was as
 * self-consistent as the original (ASSURE-PILOT-01, F01). Here the Host keeps
 * the release it issued, in the Assurance Store, as an append-only record:
 *
 * - **Identity.** A release is identified by the report it releases
 *   (`reportId` = assessment + report version): one report version, one
 *   release. The store's primary key on `reportId` arbitrates concurrent and
 *   repeated releases; a reissue is a new report version.
 * - **What is kept.** The manifest and the release record exactly as
 *   delivered, plus the tenant and the assessment. `recordDigest` covers the
 *   whole record, so a partial edit of a stored row is detected on read.
 * - **Verification.** A package matches the authority when its release
 *   record and manifest equal the stored ones and its files verify against its
 *   manifest. Only the Host's own store, reached through an authorized context,
 *   is the authority; a database file someone hands over is comparison
 *   material.
 *
 * What custody does NOT provide: a digital signature, non-repudiation
 * independent of the issuer, or protection against someone who can write the
 * store directly and recompute every digest. See
 * docs/security/ASSURE-REL-01A-DURABLE-RELEASE-AUTHENTICITY.md.
 */

export const COMMERCIAL_RELEASE_CUSTODY_VERSION = 'aoc.assurance.commercial-release-custody.v1';

export interface CommercialReleaseCustodyRecord {
  readonly custodyVersion: string;
  /** The release's stable identity: the report version it releases. */
  readonly reportId: string;
  /** The assessed organization, derived from the stored assessment -- never from the request. Kept out of the delivered package. */
  readonly organizationId: string;
  readonly assessmentId: string;
  /** The manifest the release approved, as delivered. */
  readonly manifest: CommercialReportManifest;
  /** The release record exactly as returned to the approver and delivered. */
  readonly release: CommercialReportRelease;
  /** sha256 over the canonical JSON of every other field. */
  readonly recordDigest: string;
}

export interface CommercialReleaseCustodyCommit {
  /** `committed`: this call recorded the release. `existing`: a release for the same `reportId` was already in custody and nothing was written. */
  readonly outcome: 'committed' | 'existing';
  readonly record: CommercialReleaseCustodyRecord;
}

export function buildCommercialReleaseCustodyRecord(input: {
  readonly organizationId: string;
  readonly manifest: CommercialReportManifest;
  readonly release: CommercialReportRelease;
}): CommercialReleaseCustodyRecord {
  const body = {
    custodyVersion: COMMERCIAL_RELEASE_CUSTODY_VERSION,
    reportId: input.release.reportId,
    organizationId: input.organizationId,
    assessmentId: input.release.assessmentId,
    manifest: input.manifest,
    release: input.release,
  };
  return { ...body, recordDigest: computeDigest(body) };
}

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _omitted, ...rest } = value;
  return rest;
};

/** Why `record` is not a coherent custody record, or an empty list. Checked before a write and after every read. */
export function commercialReleaseCustodyViolations(record: CommercialReleaseCustodyRecord): readonly string[] {
  const violations: string[] = [];
  const { manifest, release } = record;
  if (record.custodyVersion !== COMMERCIAL_RELEASE_CUSTODY_VERSION) violations.push('custodyVersion');
  if (typeof record.organizationId !== 'string' || record.organizationId.length === 0) violations.push('organizationId');
  if (computeDigest(without(record, 'recordDigest')) !== record.recordDigest) violations.push('recordDigest');
  if (computeDigest(without(release, 'releaseDigest')) !== release.releaseDigest) violations.push('release.releaseDigest');
  if (computeDigest(without(manifest, 'manifestDigest')) !== manifest.manifestDigest) violations.push('manifest.manifestDigest');
  if (release.contentDigest !== manifest.contentDigest || release.markdownDigest !== manifest.markdownDigest || release.manifestDigest !== manifest.manifestDigest) {
    violations.push('release.digests');
  }
  if (record.reportId !== release.reportId || record.reportId !== manifest.reportId) violations.push('reportId');
  if (record.assessmentId !== release.assessmentId || record.assessmentId !== manifest.assessmentId) violations.push('assessmentId');
  if (release.approverRole !== COMMERCIAL_REPORT_RELEASE_ROLE || release.approvalAuthentication !== 'assurance_reviewer_credential') violations.push('release.approver');
  if (manifest.readiness !== 'READY_FOR_RELEASE') violations.push('manifest.readiness');
  return violations;
}

/**
 * Whether a release request may be answered with the release already in
 * custody (`undefined`: an idempotent replay) or conflicts with it. A replay
 * is the same approver approving the same content, Markdown and manifest;
 * anything else under the same `reportId` is refused, never overwritten.
 */
export function commercialReleaseConflict(
  existing: CommercialReleaseCustodyRecord,
  candidate: { readonly contentDigest: string; readonly markdownDigest: string; readonly manifestDigest: string; readonly approvedBy: string },
): 'content' | 'approver' | undefined {
  const release = existing.release;
  if (release.contentDigest !== candidate.contentDigest || release.markdownDigest !== candidate.markdownDigest || release.manifestDigest !== candidate.manifestDigest) return 'content';
  if (release.approvedBy !== candidate.approvedBy) return 'approver';
  return undefined;
}

// ---------------------------------------------------------------------------
// Verification of a delivered package against custody
// ---------------------------------------------------------------------------

/** The files of a delivered package. Every field is untrusted input. */
export interface CommercialReleasePackage {
  readonly content: unknown;
  readonly markdown: string;
  readonly manifest: CommercialReportManifest;
  readonly release?: CommercialReportRelease;
}

/** What the authority answered for a package's `reportId`. */
export type CommercialReleaseAuthorityLookup =
  | { readonly kind: 'record'; readonly record: CommercialReleaseCustodyRecord }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly code: string };

export type CommercialReleaseAuthorityStatus = 'RELEASE_MATCHES_AUTHORITY' | 'RELEASE_MISMATCH' | 'RELEASE_NOT_IN_CUSTODY' | 'AUTHORITY_UNAVAILABLE';

export interface CommercialReleaseAuthorityVerification {
  /** The package's files are consistent with its own manifest and release record. Says nothing about who produced them. */
  readonly integrity: 'INTEGRITY_VALID' | 'INTEGRITY_INVALID';
  readonly integrityChecks: CommercialReportVerification['checks'];
  readonly authority: CommercialReleaseAuthorityStatus;
  /** Fields of the delivered release record or manifest that differ from custody, e.g. `release.approvedBy`. */
  readonly mismatchedFields: readonly string[];
  /** Integrity valid AND the release matches the Host's custody record. The strongest statement this verification makes. */
  readonly releaseAuthenticated: boolean;
  /** The approval as the Host recorded it when it happened. Present when the release is in custody. */
  readonly custody?: {
    readonly reportId: string;
    readonly approvedBy: string;
    readonly approverRole: string;
    readonly approvedAt: string;
    readonly releaseDigest: string;
  };
  /** Whether that approver still holds the release role today. A later revocation does not rewrite the recorded approval. */
  readonly approverCurrentlyAuthorized?: boolean;
  /** Present when the authority could not be consulted. */
  readonly authorityFailure?: string;
  /** Always: no digital signature exists that a third party could verify without asking the issuer. */
  readonly externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE';
}

function differingFields(prefix: string, delivered: unknown, kept: object): string[] {
  if (delivered === null || typeof delivered !== 'object') return [prefix];
  const deliveredRecord = delivered as Record<string, unknown>;
  const keptRecord = kept as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(deliveredRecord), ...Object.keys(keptRecord)])].sort();
  return keys.filter((key) => computeDigest(deliveredRecord[key] ?? null) !== computeDigest(keptRecord[key] ?? null)).map((key) => `${prefix}.${key}`);
}

function packageIntegrity(input: CommercialReleasePackage): CommercialReportVerification {
  try {
    return verifyCommercialReport(input);
  } catch {
    return { valid: false, checks: { content: false, markdown: false, manifest: false, release: false } };
  }
}

/**
 * Compares a delivered package with what the authority holds for its
 * `reportId`. The caller chooses the authority; this function only compares.
 * Treat a lookup answered from a source of unknown provenance as comparison,
 * not as authentication.
 */
export function verifyCommercialReleaseAgainstCustody(
  input: CommercialReleasePackage,
  lookup: CommercialReleaseAuthorityLookup,
  approverCurrentlyAuthorized?: boolean,
): CommercialReleaseAuthorityVerification {
  const integrity = packageIntegrity(input);
  const base = {
    integrity: integrity.valid ? ('INTEGRITY_VALID' as const) : ('INTEGRITY_INVALID' as const),
    integrityChecks: integrity.checks,
    externalSignature: 'EXTERNAL_SIGNATURE_NOT_AVAILABLE' as const,
  };
  if (lookup.kind === 'unavailable') {
    return { ...base, authority: 'AUTHORITY_UNAVAILABLE', mismatchedFields: [], releaseAuthenticated: false, authorityFailure: lookup.code };
  }
  if (lookup.kind === 'absent') {
    return { ...base, authority: 'RELEASE_NOT_IN_CUSTODY', mismatchedFields: [], releaseAuthenticated: false };
  }
  const { record } = lookup;
  const mismatchedFields = [
    ...(input.release === undefined ? ['release'] : differingFields('release', input.release, record.release)),
    ...differingFields('manifest', input.manifest, record.manifest),
  ];
  const matches = mismatchedFields.length === 0;
  return {
    ...base,
    authority: matches ? 'RELEASE_MATCHES_AUTHORITY' : 'RELEASE_MISMATCH',
    mismatchedFields,
    releaseAuthenticated: matches && integrity.valid,
    custody: {
      reportId: record.reportId,
      approvedBy: record.release.approvedBy,
      approverRole: record.release.approverRole,
      approvedAt: record.release.approvedAt,
      releaseDigest: record.release.releaseDigest,
    },
    ...(approverCurrentlyAuthorized !== undefined ? { approverCurrentlyAuthorized } : {}),
  };
}
