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
 * A witness keys a checkpoint by `(stateKind, organizationId, namespace)` —
 * one slot per kind of authority state per organization, and, for the few
 * kinds that are **namespaced**, per namespace — and records the `storeId`
 * inside it. So a checkpoint can never be confused across kinds (a
 * revocation-state sequence is not an approval sequence), across
 * organizations, across namespaces, or across stores: a different store
 * presented under an occupied slot is a substitution, not a new store. The
 * bounded-grant store is not itself organization-bound; its slot is the
 * organization of the Host that serves it.
 *
 * ## Namespaces (PAY-09 hardening)
 *
 * Most kinds hold ONE history per organization, and their slot has no
 * namespace — exactly the CORE-07 slot, unchanged. A **namespaced** kind
 * (`NAMESPACED_AUTHORITY_STATE_KINDS`) is a family of independent histories in
 * one organization, each kept by its own store, each needing its own slot: a
 * namespaced binding always names its namespace, and an un-namespaced one
 * never does. The rule is per kind and closed, so neither side can be
 * reinterpreted as the other — an un-namespaced slot of a namespaced kind (a
 * pre-namespace binding) is never read as a namespace, and no namespace can
 * be attached to a kind that has none.
 *
 * A namespace is a bounded, canonical, lowercase token chosen by the trusted
 * composition that opens the store (`isAuthorityStateNamespace`): not secret,
 * not a path, not a URL, compared exactly, never folded or trimmed. CORE gives
 * it no meaning beyond "a separate slot" — it does not know what the caller
 * namespaces by.
 */

export const AUTHORITY_STATE_CHECKPOINT_FORMAT = 'frontera.authority-state-checkpoint.v1';

/** The format of a **namespaced** checkpoint's canonical bytes. Never the v1 format: v1 bytes can never denote a namespaced slot. */
export const AUTHORITY_STATE_NAMESPACED_CHECKPOINT_FORMAT = 'frontera.authority-state-checkpoint.v2';

/**
 * The three durable **authority** stores — the only kinds the enrollment
 * ceremony and the authority-store composition know. Governance semantics
 * live here and nowhere else.
 */
export const AUTHORITY_STORE_KINDS = ['bounded-grant-revocation-state', 'obligation-discharge-state', 'approval-state'] as const;

export type AuthorityStoreKind = (typeof AUTHORITY_STORE_KINDS)[number];

/**
 * The closed set of anchored state. Nothing else is anchored, and nothing else
 * can be named. Beyond the authority stores, three operational safety states —
 * never authority, and never enrolled by the authority ceremony:
 *
 * - `xrpl-submission-reservations` (PAY-03): the append-only reservation
 *   history of the XRPL submission interlock, whose rollback could let a
 *   restarted Host reuse a source account's `Sequence` while an earlier
 *   transaction is still live;
 * - `payment-business-operation-state` (PAY-04 hardening): the append-only
 *   history of payment business operations and the protocol challenges each
 *   one owns, whose rollback could make a challenge already paid for look
 *   unowned, and so payable again under a new business operation;
 * - `payment-refund-state` (PAY-05): the append-only refund accounting of
 *   settled payments, whose rollback could recreate refundable balance, and so
 *   let the same money be refunded twice;
 * - `payment-initiation-reservations` (PAY-06): the append-only history that
 *   binds each governed execution to the one rail-level payment it may
 *   initiate (and each rail payment identity to one execution), whose rollback
 *   could make a payment already initiated look new, and so initiable twice.
 *
 * The witness treats each exactly like any other slot. This module knows
 * nothing else about them: each store lives in its own payment composition
 * edge, outside CORE, and maps itself onto a checkpoint.
 */
export const AUTHORITY_STATE_KINDS = [...AUTHORITY_STORE_KINDS, 'xrpl-submission-reservations', 'payment-business-operation-state', 'payment-refund-state', 'payment-initiation-reservations'] as const;

export type AuthorityStateKind = (typeof AUTHORITY_STATE_KINDS)[number];

/**
 * The kinds whose slot is namespaced: one organization may hold several
 * independent histories of the kind, each under its own namespace.
 *
 * - `payment-initiation-reservations` (PAY-09 hardening): every payment rail
 *   keeps its own initiation history in its own store (PAY-06, PAY-09), and
 *   one organization composes several rails — so each rail's store anchors in
 *   its own namespace, and no rail's store can take, replace or roll back
 *   another's.
 *
 * Every other kind keeps its single per-organization slot, byte-for-byte the
 * CORE-07 slot.
 */
export const NAMESPACED_AUTHORITY_STATE_KINDS = ['payment-initiation-reservations'] as const satisfies readonly AuthorityStateKind[];

export function isNamespacedAuthorityStateKind(value: unknown): boolean {
  return typeof value === 'string' && (NAMESPACED_AUTHORITY_STATE_KINDS as readonly string[]).includes(value);
}

export const AUTHORITY_STATE_NAMESPACE_MAX = 64;
/** Lowercase ASCII words joined by single hyphens. No dot, colon, slash, underscore, space or upper case: never a path, a URL or a second spelling of the same namespace. */
const NAMESPACE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A bounded, canonical namespace token. Validated before it is written or sent; compared exactly. */
export function isAuthorityStateNamespace(value: unknown): value is string {
  return typeof value === 'string' && value.length <= AUTHORITY_STATE_NAMESPACE_MAX && NAMESPACE.test(value);
}

export function isAuthorityStoreKind(value: unknown): value is AuthorityStoreKind {
  return typeof value === 'string' && (AUTHORITY_STORE_KINDS as readonly string[]).includes(value);
}

export function isAuthorityStateKind(value: unknown): value is AuthorityStateKind {
  return typeof value === 'string' && (AUTHORITY_STATE_KINDS as readonly string[]).includes(value);
}

/** The witness slot: one per kind of authority state per organization — and per namespace, for a namespaced kind. Closed: no other field. */
export interface AuthorityStateBinding {
  readonly stateKind: AuthorityStateKind;
  readonly organizationId: string;
  /** Present exactly when `stateKind` is namespaced (`NAMESPACED_AUTHORITY_STATE_KINDS`). */
  readonly namespace?: string;
}

/** The part of a slot a store chooses (the boundary supplies the organization). */
export interface AuthorityStateSlot {
  readonly stateKind: AuthorityStateKind;
  readonly namespace?: string;
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

/** Why `value`'s namespace does not fit its kind, or `undefined`. Names the rule, never the value. */
export function authorityStateNamespaceProblem(value: { readonly stateKind: unknown; readonly namespace?: unknown }): string | undefined {
  const present = Object.prototype.hasOwnProperty.call(value, 'namespace') && value.namespace !== undefined;
  if (isNamespacedAuthorityStateKind(value.stateKind)) {
    if (!present) return 'names a namespaced state kind without its namespace';
    if (!isAuthorityStateNamespace(value.namespace)) return 'names a namespace that is not a bounded canonical token';
    return undefined;
  }
  return present ? 'names a namespace for a state kind that has none' : undefined;
}

/** Why `value` is not a well-formed binding, or `undefined` when it is. Names the rule, never the value. */
export function authorityStateBindingProblem(value: AuthorityStateBinding): string | undefined {
  if (!isAuthorityStateKind(value.stateKind)) return 'names a state kind outside the closed set';
  if (!isBoundedIdentifier(value.organizationId)) return 'names no well-formed organization';
  return authorityStateNamespaceProblem(value);
}

/** Why `value` is not a well-formed checkpoint, or `undefined` when it is. Names the rule, never the value. */
export function authorityStateCheckpointProblem(value: AuthorityStateCheckpoint): string | undefined {
  const binding = authorityStateBindingProblem(value);
  if (binding !== undefined) return binding;
  if (!isBoundedIdentifier(value.storeId)) return 'names no well-formed store';
  if (!isStateSequence(value.sequence)) return 'carries a sequence that is not a non-negative safe integer';
  if (!isStateDigest(value.stateDigest)) return 'carries a state digest that is not sha256:<64 hex>';
  return undefined;
}

const quote = (value: string): string => JSON.stringify(value);

/** Canonical bytes of a binding. Keys fixed and sorted; `namespace` present exactly for a namespaced slot. */
export function serializeAuthorityStateBinding(binding: AuthorityStateBinding): string {
  const namespace = binding.namespace !== undefined ? `"namespace":${quote(binding.namespace)},` : '';
  return `{${namespace}"organizationId":${quote(binding.organizationId)},"stateKind":${quote(binding.stateKind)}}`;
}

/**
 * Canonical bytes of a checkpoint: versioned, keys fixed and sorted. Every
 * field that identifies the state is in here — the format, the kind, the
 * organization, the namespace of a namespaced slot, the store, the sequence and
 * the digest — so two checkpoints serialize equal exactly when they denote the
 * same state. An un-namespaced checkpoint serializes byte-for-byte as v1; a
 * namespaced one only under the v2 format.
 */
export function serializeAuthorityStateCheckpoint(checkpoint: AuthorityStateCheckpoint): string {
  const namespaced = checkpoint.namespace !== undefined;
  return [
    '{',
    [
      `"format":${quote(namespaced ? AUTHORITY_STATE_NAMESPACED_CHECKPOINT_FORMAT : AUTHORITY_STATE_CHECKPOINT_FORMAT)}`,
      ...(namespaced ? [`"namespace":${quote(checkpoint.namespace as string)}`] : []),
      `"organizationId":${quote(checkpoint.organizationId)}`,
      `"sequence":${String(checkpoint.sequence)}`,
      `"stateDigest":${quote(checkpoint.stateDigest)}`,
      `"stateKind":${quote(checkpoint.stateKind)}`,
      `"storeId":${quote(checkpoint.storeId)}`,
    ].join(','),
    '}',
  ].join('');
}

/** Same slot: kind, organization and namespace, compared exactly (an absent namespace equals only an absent namespace). */
export function sameBinding(a: AuthorityStateBinding, b: AuthorityStateBinding): boolean {
  return a.stateKind === b.stateKind && a.organizationId === b.organizationId && a.namespace === b.namespace;
}

export function sameHead(a: AuthorityStateHead, b: AuthorityStateHead): boolean {
  return a.sequence === b.sequence && a.stateDigest === b.stateDigest;
}

/** Same state: same binding, same store, same sequence **and** same digest. A sequence alone never identifies a state. */
export function sameCheckpoint(a: AuthorityStateCheckpoint, b: AuthorityStateCheckpoint): boolean {
  return sameBinding(a, b) && a.storeId === b.storeId && sameHead(a, b);
}

/** The slot a binding or checkpoint names — exactly its closed fields, nothing else carried along. */
export function bindingOf(checkpoint: AuthorityStateBinding): AuthorityStateBinding {
  return checkpoint.namespace !== undefined
    ? { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId, namespace: checkpoint.namespace }
    : { stateKind: checkpoint.stateKind, organizationId: checkpoint.organizationId };
}

/** A human label for a slot in a refusal message: the kind, and the namespace of a namespaced slot. */
export function slotLabel(binding: { readonly stateKind: string; readonly namespace?: string }): string {
  return binding.namespace !== undefined ? `${binding.stateKind} [${binding.namespace}]` : binding.stateKind;
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
