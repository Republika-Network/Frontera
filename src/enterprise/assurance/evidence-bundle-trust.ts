import type { EvidenceVerificationResult } from '../evidence/contracts.js';
import type { EvidenceBundleCurrentTraceLookup } from '../evidence/bundle-current-trace.js';
import type { AssuranceEvidenceRejectionCode } from './contracts.js';

/**
 * Host evidence attribution and Evidence Bundle verification outcomes
 * (ASSURE-SEC-01D).
 *
 * - **Attribution.** Evidence belongs to the organization its canonical store
 *   recorded for it, never to the organization being assessed by default. An
 *   empty `organizationId` means "not attributable": the resolver rejects it
 *   as out of the assessment's tenant scope.
 * - **Verification.** A bundle's verification failures map to distinct codes:
 *   an integrity failure is not a missing source, and a canonical trace that
 *   could not be rebuilt is not a contradiction.
 *
 * Verification proves the bundle matches the Host's canonical records. It
 * says nothing about the truth of what those records describe.
 */

/** The `organizationId` of evidence whose canonical source records no organization. */
export const UNATTRIBUTED_ORGANIZATION = '';

export interface BundleAttribution {
  readonly organizationId: string;
  /** Present when the bundle's own disclosed organization contradicts its store owner. */
  readonly conflict?: true;
}

/**
 * The organization an Evidence Bundle belongs to: the owner its Evidence Store
 * recorded (`EvidenceBundleRecord.organizationId`, the field the store's own
 * tenant checks use). A bundle with no recorded owner is not attributable;
 * one whose disclosed `source.organizationId` names a different organization
 * than its owner is not attributable either.
 */
export function attributeEvidenceBundle(storedOwner: string | undefined, disclosedOrganizationId: string | undefined): BundleAttribution {
  if (storedOwner === undefined || storedOwner.length === 0) return { organizationId: UNATTRIBUTED_ORGANIZATION };
  if (disclosedOrganizationId !== undefined && disclosedOrganizationId !== storedOwner) return { organizationId: UNATTRIBUTED_ORGANIZATION, conflict: true };
  return { organizationId: storedOwner };
}

/** Verifier checks whose failure means the bundle's content or digest binding does not hold. */
const INTEGRITY_CHECKS = new Set(['bundleDigest', 'verificationDigest', 'recordDigest', 'traceDigest', 'policyMatch']);

export interface BundleVerificationRejection {
  readonly codes: readonly AssuranceEvidenceRejectionCode[];
  readonly detail?: string;
}

/**
 * Classifies a bundle verification. `trace` is the canonical-trace lookup for
 * a v2 bundle, and `undefined` for v1 (which has no trace). Details are fixed
 * sentences: no store message, path or other tenant's data reaches them.
 */
export function classifyBundleVerification(result: EvidenceVerificationResult, trace: EvidenceBundleCurrentTraceLookup | undefined): BundleVerificationRejection {
  if (result.valid) return { codes: [] };
  const codes = new Set<AssuranceEvidenceRejectionCode>();
  const details: string[] = [];
  const failed = new Set(result.failures.map((failure) => failure.check));
  const traceRebuilt = trace?.status === 'rebuilt' && trace.currentTrace !== undefined;

  if ([...failed].some((check) => INTEGRITY_CHECKS.has(check))) {
    codes.add('EVIDENCE_DIGEST_MISMATCH');
    details.push('Evidence Bundle failed integrity verification.');
  }
  if (failed.has('versionSupported')) {
    codes.add('EVIDENCE_VERSION_UNSUPPORTED');
    details.push('Evidence Bundle version or content is not supported by this build.');
  }
  if (failed.has('complete')) {
    codes.add('EVIDENCE_INCOMPLETE');
    details.push('Evidence Bundle is missing a field its disclosure policy requires.');
  }
  if (trace !== undefined && !traceRebuilt) {
    codes.add('EVIDENCE_SOURCE_UNAVAILABLE');
    details.push(
      trace.status === 'read-failed'
        ? 'The canonical trace of the bundle\'s request could not be read; the bundle cannot be verified against its sources.'
        : 'The canonical trace of the bundle\'s request could not be rebuilt in the assessed organization\'s scope; the bundle cannot be verified against its sources.',
    );
  } else if (traceRebuilt) {
    if (failed.has('traceConsistent')) {
      codes.add('EVIDENCE_CONTRADICTORY');
      details.push('The canonical records contradict a fact the bundle disclosed.');
    }
    if (result.traceComparison?.result === 'unverifiable') {
      codes.add('EVIDENCE_SOURCE_UNAVAILABLE');
      details.push('The canonical trace is degraded; the bundle cannot be compared with it.');
    }
    if (failed.has('sourceTraceVerified')) {
      codes.add('EVIDENCE_UNVERIFIED');
      details.push('The canonical trace of the bundle\'s request does not verify.');
    }
  }
  if (codes.size === 0) {
    // A failure this classification does not know is still a failure: never accepted.
    codes.add('EVIDENCE_UNVERIFIED');
    details.push('Evidence Bundle failed verification.');
  }
  return { codes: [...codes], detail: details.join(' ') };
}
