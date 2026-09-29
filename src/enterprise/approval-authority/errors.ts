export type ApprovalAuthorityErrorCode =
  /** The command context is not a trusted, authenticated actor context. */
  | 'APPROVAL_CONTEXT_UNTRUSTED'
  /** The command is malformed, or names an approval request or subject that is not awaiting it. */
  | 'APPROVAL_INVALID'
  /** approval-runtime refused the actor: not recognized, no live Kernel-Authority for the approver action over the resource, out of scope, or segregation of duties. */
  | 'APPROVAL_APPROVER_INELIGIBLE'
  /** The same approver already approved; they never count twice. */
  | 'APPROVAL_DUPLICATE'
  /** The approval did not cite every evidence type the requirement names. */
  | 'APPROVAL_EVIDENCE_INSUFFICIENT'
  /** The request is no longer open: approved, rejected, revoked, or past its approval window. */
  | 'APPROVAL_REQUEST_CLOSED'
  /** The request was opened under a Governance Profile or requirement trusted configuration no longer holds; it is invalidated, never reinterpreted. */
  | 'APPROVAL_REQUEST_SUPERSEDED'
  /** A stored row failed verification; nothing read from the store is believed. */
  | 'APPROVAL_STORE_CORRUPT'
  /** The store file is not one this build understands, or no authenticity boundary was supplied. */
  | 'APPROVAL_STORE_UNSUPPORTED'
  /** The store was used after it was closed. */
  | 'APPROVAL_STORE_CLOSED';

export class ApprovalAuthorityError extends Error {
  readonly code: ApprovalAuthorityErrorCode;
  /** approval-runtime's own reason code, when its policies refused the command. */
  readonly reasonCode: string | undefined;

  constructor(code: ApprovalAuthorityErrorCode, message: string, reasonCode?: string) {
    super(message);
    this.name = 'ApprovalAuthorityError';
    this.code = code;
    this.reasonCode = reasonCode;
  }
}
