import type { ApprovalStateCommitment } from '../approval-authority/state-commitment.js';
import type { RevocationStateCommitment } from '../bounded-grant-store/bounded-grant-record.js';
import type { ObligationDischargeStateCommitment } from '../obligation-discharge/state-commitment.js';

/**
 * CORE-07 — the one checkpoint model every rollback-sensitive authority store
 * anchors.
 *
 * ## Why a checkpoint at all
 *
 * Each authenticated store already signs its own state head: the bounded-grant
 * store its revocation-state commitment (CORE-01), the discharge and approval
 * stores their chain heads (CORE-04, CORE-05). A signature proves a trusted
 * key vouched for a state; it cannot prove that state is the **newest** one — a
 * captured older head verifies exactly as well as the current one. So each
 * store's already-signed head is mapped, unchanged, onto this checkpoint, and
 * the checkpoint is what an external witness outside the store's restore
 * domain holds (`session.ts`, `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md`).
 * No store signature, schema or sequence changes: CORE-07 reuses the monotonic
 * sequence and digest each head already carries.
 *
 * ## The binding
 *
 * A witness keys a checkpoint by `(stateKind, organizationId)` — one slot per
 * kind of authority state per organization — and records the `storeId` inside
 * it. So a checkpoint can never be confused across kinds (a revocation-state
 * sequence is not an approval sequence), across organizations, or across
 * stores: a different store presented under an occupied slot is a
 * substitution, not a new store. The bounded-grant store is not itself
 * organization-bound; its slot is the organization of the Host that serves it.
 */

export const AUTHORITY_STATE_CHECKPOINT_FORMAT = 'frontera.authority-state-checkpoint.v1';

/** The closed set of freshness-relevant authority state. Nothing else is anchored, and nothing else can be named. */
export const AUTHORITY_STATE_KINDS = ['bounded-grant-revocation-state', 'obligation-discharge-state', 'approval-state'] as const;

export type AuthorityStateKind = (typeof AUTHORITY_STATE_KINDS)[number];

export function isAuthorityStateKind(value: unknown): value is AuthorityStateKind {
  return typeof value === 'string' && (AUTHORITY_STATE_KINDS as readonly string[]).includes(value);
}

/** The witness slot: one per kind of authority state per organization. */
export interface AuthorityStateBinding {
  readonly stateKind: AuthorityStateKind;
  readonly organizationId: string;
}

/** A position in one store's authority history: its monotonic sequence and the digest the store's signed head commits to there. */
export interface AuthorityStateHead {
  readonly sequence: number;
  readonly stateDigest: string;
}

export interface AuthorityStateCheckpoint extends AuthorityStateBinding, AuthorityStateHead {
  readonly storeId: string;
}

const IDENTIFIER_MAX = 512;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTIFIER_MAX && value.trim() === value && !/[\u0000-\u001f]/.test(value);
}

export function isStateDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

export function isStateSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Why `value` is not a well-formed checkpoint, or `undefined` when it is. Names the rule, never the value. */
export function authorityStateCheckpointProblem(value: AuthorityStateCheckpoint): string | undefined {
  if (!isAuthorityStateKind(value.stateKind)) return 'names a state kind outside the closed set';
  if (!isBoundedIdentifier(value.organizationId)) return 'names no well-formed organization';
  if (!isBoundedIdentifier(value.storeId)) return 'names no well-formed store';
  if (!isStateSequence(value.sequence)) return 'carries a sequence that is not a non-negative safe integer';
  if (!isStateDigest(value.stateDigest)) return 'carries a state digest that is not sha256:<64 hex>';
  return undefined;
}

const quote = (value: string): string => JSON.stringify(value);

/** Canonical bytes of a binding. Keys fixed and sorted. */
export function serializeAuthorityStateBinding(binding: AuthorityStateBinding): string {
  return `{"organizationId":${quote(binding.organizationId)},"stateKind":${quote(binding.stateKind)}}`;
}

/**
 * Canonical bytes of a checkpoint: versioned, keys fixed and sorted, nothing
 * optional. Every field that identifies the state is in here — the format, the
 * kind, the organization, the store, the sequence and the digest — so two
 * checkpoints serialize equal exactly when they denote the same state.
 */
export function serializeAuthorityStateCheckpoint(checkpoint: AuthorityStateCheckpoint): string {
  return [
    '{',
    [
      `"format":${quote(AUTHORITY_STATE_CHECKPOINT_FORMAT)}`,
      `"organizationId":${quote(checkpoint.organizationId)}`,
      `"sequence":${String(checkpoint.sequence)}`,
      `"stateDigest":${quote(checkpoint.stateDigest)}`,
      `"stateKind":${quote(checkpoint.stateKind)}`,
      `"storeId":${quote(checkpoint.storeId)}`,
    ].join(','),
    '}',
  ].join('');
}

export function sameBinding(a: AuthorityStateBinding, b: AuthorityStateBinding): boolean {
  return a.stateKind === b.stateKind && a.organizationId === b.organizationId;
}

export function sameHead(a: AuthorityStateHead, b: AuthorityStateHead): boolean {
  return a.sequence === b.sequence && a.stateDigest === b.stateDigest;
}

/** Same state: same binding, same store, same sequence **and** same digest. A sequence alone never identifies a state. */
export function sameCheckpoint(a: AuthorityStateCheckpoint, b: AuthorityStateCheckpoint): boolean {
  return sameBinding(a, b) && a.storeId === b.storeId && sameHead(a, b);
}

export function bindingOf(checkpoint: AuthorityStateCheckpoint): AuthorityStateBinding {
  return { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId };
}

export function headOf(checkpoint: AuthorityStateHead): AuthorityStateHead {
  return { sequence: checkpoint.sequence, stateDigest: checkpoint.stateDigest };
}

/** The bounded-grant store's signed revocation-state commitment (CORE-01), as a checkpoint in its Host organization's slot. */
export function revocationStateCheckpoint(commitment: RevocationStateCommitment, organizationId: string): AuthorityStateCheckpoint {
  return { stateKind: 'bounded-grant-revocation-state', organizationId, storeId: commitment.storeId, sequence: commitment.sequence, stateDigest: commitment.revocationSetDigest };
}

/** The discharge store's signed chain head (CORE-04). Organization-bound by the head itself. */
export function obligationDischargeStateCheckpoint(state: ObligationDischargeStateCommitment): AuthorityStateCheckpoint {
  return { stateKind: 'obligation-discharge-state', organizationId: state.organizationId, storeId: state.storeId, sequence: state.sequence, stateDigest: state.chainDigest };
}

/** The approval store's signed chain head (CORE-05). Organization-bound by the head itself. */
export function approvalStateCheckpoint(state: ApprovalStateCommitment): AuthorityStateCheckpoint {
  return { stateKind: 'approval-state', organizationId: state.organizationId, storeId: state.storeId, sequence: state.sequence, stateDigest: state.chainDigest };
}
