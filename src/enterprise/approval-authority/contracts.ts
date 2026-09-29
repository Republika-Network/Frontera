import type { ApprovalRowContent } from './state-commitment.js';

/**
 * CORE-05 — approvals as durable authority records.
 *
 * ## What this store is, and what it is not
 *
 * It is an append-only log of facts about the human approval of governed
 * decisions that awaited one:
 *
 * - `requested` — written by the governed path itself, the first time it
 *   withholds a decision for approval: "request R's committed decision D, whose
 *   canonical subject is S (digest H), awaits approval";
 * - `approved`, `rejected`, `requested_changes`, `escalated`, `revoked` —
 *   written by the trusted command service: "authenticated actor A gave
 *   verdict V on exactly H, having reviewed evidence E".
 *
 * It is **not** the approval state. State is never stored: it is derived,
 * every time it is read, by a pure evaluation (`evaluation.ts`) over these
 * rows, the approval requirement snapshotted into the request and the
 * approvers' authority in the durable Kernel-Authority world *now*, through
 * approval-runtime's own policies. So nothing
 * written here can declare a request approved: a row from an approver without
 * live authority, from the requester, after the request expired, for another
 * decision or for another subject simply does not count.
 *
 * ## Why append-only and signed
 *
 * A completed approval resumes a withheld decision into bounded authority. The
 * log is therefore authority-material, committed like CORE-04's discharge log:
 * every append advances a hash chain over the whole history and the head is
 * signed by the deployment's authority key; every read verifies the signature
 * and the chain (`state-commitment.ts`, `integrity.ts`).
 */

/** One stored row: its content, its position in the store's history, and the digest that position binds. */
export interface StoredApprovalRecord extends ApprovalRowContent {
  /** 1-based position in the store's append-only history. */
  readonly sequence: number;
  /** `sha256:<hex>` over the row bound to its store and sequence (`approvalRowDigest`). */
  readonly digest: string;
}

export interface ApprovalStore {
  /**
   * `durable-authenticated` — SQLite, every append advances a hash chain whose
   * head is signed by the deployment's authority key, and every read verifies
   * the signature and the whole chain. `ephemeral` — process memory only;
   * refused by the secure profile.
   */
  readonly kind: 'durable-authenticated' | 'ephemeral';
  /** Appends one row and advances the committed state. Nothing is written if the committed state cannot first be verified, or the new state cannot be signed. */
  append(content: ApprovalRowContent): Promise<StoredApprovalRecord>;
  /**
   * The authoritative read: verifies the store's committed state — signature,
   * chain over every row, organization, store identity — and only then returns
   * the rows of one governed request (or, without one, every row), in append
   * order. Throws when anything fails; nothing read from an unverifiable store
   * is believed.
   */
  read(organizationId: string, requestId?: string): Promise<readonly StoredApprovalRecord[]>;
  close(): Promise<void>;
}

/** v1: the authenticated format (signed chain head) — the only one. */
export const APPROVAL_STORE_SCHEMA_VERSION = 1;

/**
 * The trusted command context: **who** is acting, as established by trusted
 * in-process code that authenticated them — never by the command. Future
 * CTRL-04 authenticates the human and constructs it; until then only
 * in-process trusted code can (there is no HTTP route to the command service,
 * and the CTRL-01 administrator credential is not one). A command carries no
 * actor field at all, so request data can never name — or spoof — an
 * approver.
 */
export interface ApprovalCommandContext {
  readonly authenticated: true;
  /** The authenticated Kernel-Authority actor issuing the command. Their standing is checked against the durable world, never taken from here. */
  readonly actorId: string;
  /** The trusted channel that authenticated them. Recorded on the row, digested, never interpreted. */
  readonly authenticatedBy: string;
}

/** One reviewed evidence reference: approval-runtime's evidence type, a `sha256:` content hash, optionally where it lives. */
export interface ApprovalEvidenceInput {
  readonly type: string;
  readonly hash: string;
  readonly uri?: string;
}

/** What a command names: the approval request and the exact subject the actor was shown. Closed: nothing else is accepted. */
export interface ApprovalCommand {
  readonly approvalRequestId: string;
  /** The digest of the subject the actor was shown (from `describe()`); a command against any other subject is refused. */
  readonly subjectDigest: string;
  /** The evidence the actor reviewed. Required, by type, for an approval whose requirement names evidence. */
  readonly evidence?: readonly ApprovalEvidenceInput[];
  /** An opaque note (a ticket, a comment reference, a revocation reason). Recorded, never interpreted. */
  readonly reason?: string;
}

/** The semantic operations of approval-runtime's decision service, plus revocation. */
export type ApprovalCommandKind = 'approve' | 'reject' | 'requestChanges' | 'escalate' | 'revoke';
