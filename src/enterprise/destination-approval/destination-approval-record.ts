import { createHash } from 'node:crypto';

/**
 * The canonical persisted forms of the destination approval store and their
 * integrity digests (ANDREW-P0-03).
 *
 * ## Why a hash chain and a head, not only immutable rows
 *
 * For approval, a row that silently *disappears* fails in both directions:
 * a deleted `approved` event reads as `never-approved` (closed, but a lie about
 * history), and a deleted **`revoked`** event re-activates the approval it
 * ended — the open direction. Append-only triggers stop the store's own SQL
 * from doing that, not a raw writer. So, exactly as the emergency-control
 * store does (`emergency-control-record.ts`):
 *
 * | record | what it is |
 * | --- | --- |
 * | **event** | append-only, store-wide contiguous sequence, hash-chained. One row per `approved` / `revoked` decision. |
 * | **command** | one row per accepted idempotency key: the request digest and the outcome it produced. |
 * | **head** | one row: the latest event's sequence and digest, how many events and commands must exist. |
 *
 * A read walks the whole chain and checks it against the head, so a deleted,
 * re-ordered or rewritten event — any of them, not only the latest — and a
 * deleted command are detected rather than obeyed.
 *
 * Every digest is **unkeyed** SHA-256: storage integrity, never a signature.
 * It does not stop a writer who rewrites every record and recomputes every
 * digest, nor a whole-file rollback (the grant store's GS-002 gap).
 */

export const DESTINATION_APPROVAL_RECORD_FORMAT = 'aoc.destination-approval.record.v1';

export const DESTINATION_APPROVAL_SCHEMA_VERSION = 'aoc.destination-approval.schema.v1';

export type DestinationApprovalTransition = 'approved' | 'revoked';

export function isDestinationApprovalTransition(value: unknown): value is DestinationApprovalTransition {
  return value === 'approved' || value === 'revoked';
}

export type DestinationApprovalOperation = 'approve' | 'revoke';

export type DestinationApprovalCommandOutcome = 'approved' | 'already-approved' | 'revoked' | 'already-revoked' | 'not-active';

const OUTCOMES_BY_OPERATION: Readonly<Record<DestinationApprovalOperation, readonly DestinationApprovalCommandOutcome[]>> = Object.freeze({
  approve: ['approved', 'already-approved'],
  revoke: ['revoked', 'already-revoked', 'not-active'],
});

export function isDestinationApprovalOperation(value: unknown): value is DestinationApprovalOperation {
  return value === 'approve' || value === 'revoke';
}

export function isOutcomeOf(operation: DestinationApprovalOperation, value: unknown): value is DestinationApprovalCommandOutcome {
  return typeof value === 'string' && (OUTCOMES_BY_OPERATION[operation] as readonly string[]).includes(value);
}

function digestOf(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function json(value: string | number | null): string {
  return value === null ? 'null' : typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/** Fixed lexicographic key order, no whitespace, every field present. */
function canonical(fields: Readonly<Record<string, string | number | null>>): string {
  return `{${Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${json(fields[key] ?? null)}`)
    .join(',')}}`;
}

/** The chain's anchor: the first event's `previousEventDigest`, and the head's digest while no event exists. */
export const DESTINATION_APPROVAL_GENESIS_DIGEST = digestOf(canonical({ format: DESTINATION_APPROVAL_RECORD_FORMAT, kind: 'genesis', schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION }));

export interface DestinationApprovalEventRecord {
  readonly sequence: number;
  readonly organizationId: string;
  readonly destinationKey: string;
  readonly namespace: string;
  readonly identifier: string;
  readonly transition: DestinationApprovalTransition;
  /** `approvedBy` or `revokedBy`. */
  readonly actorRef: string;
  /** `authorityBasis` or `revocationBasis`. */
  readonly authorityBasis: string;
  readonly recordedAt: string;
  /** `approved` only; `null` for no expiry and always for `revoked`. */
  readonly expiresAt: string | null;
  /** `revoked` only: the approval it ends. `null` for `approved`. */
  readonly approvalSequence: number | null;
  readonly previousEventDigest: string;
}

export function destinationApprovalEventDigest(event: DestinationApprovalEventRecord): string {
  return digestOf(
    canonical({
      actorRef: event.actorRef,
      approvalSequence: event.approvalSequence,
      authorityBasis: event.authorityBasis,
      destinationKey: event.destinationKey,
      expiresAt: event.expiresAt,
      format: DESTINATION_APPROVAL_RECORD_FORMAT,
      identifier: event.identifier,
      kind: 'event',
      namespace: event.namespace,
      organizationId: event.organizationId,
      previousEventDigest: event.previousEventDigest,
      recordedAt: event.recordedAt,
      schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION,
      sequence: event.sequence,
      transition: event.transition,
    }),
  );
}

export interface DestinationApprovalCommandRecord {
  readonly organizationId: string;
  readonly idempotencyKey: string;
  readonly operation: DestinationApprovalOperation;
  readonly requestDigest: string;
  readonly outcome: DestinationApprovalCommandOutcome;
  /** The event the outcome refers to: the new or existing approval, the new or existing revocation. `null` for `not-active`. */
  readonly eventSequence: number | null;
  readonly destinationKey: string;
  readonly actorRef: string;
  readonly recordedAt: string;
}

export function destinationApprovalCommandDigest(command: DestinationApprovalCommandRecord): string {
  return digestOf(
    canonical({
      actorRef: command.actorRef,
      destinationKey: command.destinationKey,
      eventSequence: command.eventSequence,
      format: DESTINATION_APPROVAL_RECORD_FORMAT,
      idempotencyKey: command.idempotencyKey,
      kind: 'command',
      operation: command.operation,
      organizationId: command.organizationId,
      outcome: command.outcome,
      recordedAt: command.recordedAt,
      requestDigest: command.requestDigest,
      schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION,
    }),
  );
}

/**
 * What makes two commands "the same request" under one idempotency key: the
 * operation, the destination, the terms and the actor. Not the instant.
 */
export function destinationApprovalRequestDigest(request: {
  readonly operation: DestinationApprovalOperation;
  readonly destinationKey: string;
  readonly expiresAt: string | null;
  readonly actorRef: string;
}): string {
  return digestOf(
    canonical({
      actorRef: request.actorRef,
      destinationKey: request.destinationKey,
      expiresAt: request.expiresAt,
      format: DESTINATION_APPROVAL_RECORD_FORMAT,
      kind: 'request',
      operation: request.operation,
    }),
  );
}

export interface DestinationApprovalHeadRecord {
  readonly eventSequence: number;
  readonly eventCount: number;
  readonly eventDigest: string;
  readonly commandCount: number;
  readonly updatedAt: string;
}

export function destinationApprovalHeadDigest(head: DestinationApprovalHeadRecord): string {
  return digestOf(
    canonical({
      commandCount: head.commandCount,
      eventCount: head.eventCount,
      eventDigest: head.eventDigest,
      eventSequence: head.eventSequence,
      format: DESTINATION_APPROVAL_RECORD_FORMAT,
      kind: 'head',
      schemaVersion: DESTINATION_APPROVAL_SCHEMA_VERSION,
      updatedAt: head.updatedAt,
    }),
  );
}
