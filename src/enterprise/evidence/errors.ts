/**
 * The Evidence Bundle's error taxonomy, parallel in shape to
 * `GovernanceStoreErrorCode` (mission section 42 of PR-004). Every failure
 * this module surfaces is one of these codes; raw driver/internal errors
 * never escape it.
 */
export type EvidenceErrorCode =
  /** The build/verify input is structurally invalid. */
  | 'EVIDENCE_VALIDATION_ERROR'
  /** No Governance Record exists for the requested identifier within the caller's scope -- a Bundle can never be built over a record the caller cannot see. */
  | 'EVIDENCE_SOURCE_RECORD_NOT_FOUND'
  /** The requested disclosure level does not name a known `DisclosurePolicy`. */
  | 'EVIDENCE_DISCLOSURE_POLICY_UNKNOWN'
  /** No Bundle exists for the requested `bundleId` within the caller's scope. */
  | 'EVIDENCE_BUNDLE_NOT_FOUND'
  /** A caller attempted to touch a Bundle outside its authorized tenant scope. */
  | 'EVIDENCE_ACCESS_SCOPE_VIOLATION'
  /** A non-system caller attempted a read/query without an organization scope. */
  | 'EVIDENCE_TENANT_SCOPE_REQUIRED'
  /** The Bundle Store cannot be reached. */
  | 'EVIDENCE_STORE_UNAVAILABLE'
  /** A supplied `bundleId` was already stored -- Bundles are immutable and never overwritten. */
  | 'EVIDENCE_BUNDLE_ALREADY_EXISTS'
  /** ASSURE-01: no governed request with this id exists within the caller's scope. */
  | 'EVIDENCE_TRACE_NOT_FOUND'
  /** ASSURE-01: the request's canonical records exceed the trace bounds; refused, never truncated. */
  | 'EVIDENCE_TRACE_TOO_LARGE'
  /** ASSURE-01: a durable Bundle Store row failed its integrity checks on read (digest, identity, lifecycle). Never repaired, never returned. */
  | 'EVIDENCE_STORE_CORRUPT';

export class EvidenceError extends Error {
  constructor(
    readonly code: EvidenceErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export function isEvidenceError(error: unknown): error is EvidenceError {
  return error instanceof EvidenceError;
}
