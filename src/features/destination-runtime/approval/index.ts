/**
 * Destination governance approval (ANDREW-P0-03): has organization O approved
 * destination D for governed use, right now?
 *
 * Organization-scoped, explicit, attributable, revocable and optionally
 * expiring — and separate from registry membership (P0-02), which it never
 * implies and never alters. The durable implementation is
 * `src/enterprise/destination-approval`. See
 * `docs/demo/andrew/ANDREW-P0-03-DESTINATION-APPROVAL.md`.
 *
 * A separate entry point: neither the P0-01 root barrel nor the P0-02 registry
 * barrel exports it.
 */
export {
  DESTINATION_APPROVAL_ORGANIZATION_ID_MAX_LENGTH,
  DESTINATION_GOVERNANCE_REFERENCE_MAX_LENGTH,
  DestinationApprovalError,
  buildDestinationApproval,
  buildDestinationApprovalRevocation,
  deriveDestinationApprovalState,
  isCanonicalApprovalInstant,
  isDestinationApprovalActive,
  isDestinationApprovalError,
  isDestinationApprovalExpiredAt,
  isDestinationApprovalIdempotencyKey,
  isDestinationApprovalOrganizationId,
  isDestinationGovernanceReference,
  requireApproveDestinationCommand,
  requireDestinationApprovalQuery,
  requireDestinationApprovalTarget,
  requireDestinationGovernanceAuthority,
  requireRevokeDestinationCommand,
  sampleApprovalInstant,
} from './destination-approval.js';
export type {
  ApproveDestinationCommand,
  ApproveDestinationResult,
  DestinationApproval,
  DestinationApprovalErrorCode,
  DestinationApprovalHistoryEntry,
  DestinationApprovalQuery,
  DestinationApprovalReaderPort,
  DestinationApprovalRevocation,
  DestinationApprovalState,
  DestinationApprovalStorePort,
  DestinationGovernanceAuthority,
  RevokeDestinationCommand,
  RevokeDestinationResult,
} from './destination-approval.js';
