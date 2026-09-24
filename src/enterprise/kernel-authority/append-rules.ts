import type { AppendKernelAuthorityEventInput, KernelAuthorityEvent, KernelAuthorityRecord } from './contracts.js';
import { KernelAuthorityError } from './errors.js';
import { validateKernelAuthorityMonetaryConstraints } from './monetary-constraints.js';
import { computeKernelAuthorityPayloadDigest, isKernelAuthorityEntityKind, reconstructKernelAuthorityRecord } from './kernel-authority-store.js';

/**
 * The provisioning rules both store implementations enforce, factored out so
 * the in-memory and SQLite stores can never disagree about them. Each
 * implementation supplies the state it has already loaded inside its own
 * transaction; this module decides only what that state means.
 *
 * Every rule here exists to keep one invariant: **authority narrows, never
 * widens by accident.** A retry cannot produce a second grant, a conflicting
 * retry is an error rather than a merge, and a revocation is terminal.
 */

/** What an implementation must resolve before applying an append. */
export interface KernelAuthorityAppendState {
  /** The target entity's existing event chain, oldest first; empty when it has never been provisioned. */
  readonly existingEvents: readonly KernelAuthorityEvent[];
  /** A previously recorded claim on this idempotency key within this organization, when one exists. */
  readonly idempotencyClaim?: { readonly payloadDigest: string; readonly entityKind: string; readonly entityId: string };
  /** The actor id already bound to the payload's external subject, when the payload declares one and a different actor already holds it. */
  readonly conflictingExternalSubjectActorId?: string;
}

export type KernelAuthorityAppendDecision =
  /** `payloadDigest` is carried on a replay too, because an unclaimed idempotency key still has to be pinned to this payload even when the entity itself needs no second event. */
  | { readonly outcome: 'replay'; readonly record: KernelAuthorityRecord; readonly payloadDigest: string }
  | { readonly outcome: 'append'; readonly sequence: number; readonly previousEventDigest?: string; readonly payloadDigest: string };

/** Structural validation of the append input itself, before any state is consulted. */
export function validateKernelAuthorityAppendInput(input: AppendKernelAuthorityEventInput): void {
  if (!input.organizationId || input.organizationId.trim().length === 0) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', 'A Kernel Authority event must name a non-empty organizationId.');
  }
  if (!isKernelAuthorityEntityKind(input.entityKind)) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `Unknown Kernel Authority entity kind '${String(input.entityKind)}'.`);
  }
  if (!input.entityId || input.entityId.trim().length === 0) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', 'A Kernel Authority event must name a non-empty entityId.');
  }
  if (input.eventType !== 'KernelAuthorityEntityProvisioned' && input.eventType !== 'KernelAuthorityEntityRevoked') {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `Unknown Kernel Authority event type '${String(input.eventType)}'.`);
  }
  if (input.payload === null || typeof input.payload !== 'object') {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', 'A Kernel Authority event payload must be an object.');
  }
  // P10: monetary authority is validated where it enters the durable log, by
  // both implementations, whoever the caller is.
  if (input.eventType === 'KernelAuthorityEntityProvisioned') {
    validateKernelAuthorityMonetaryConstraints(input.entityKind, input.payload, `Kernel Authority entity '${input.entityKind}:${input.entityId}'`);
  }
}

/**
 * Decides whether an append proceeds, replays, or is refused.
 *
 * Provisioning:
 *   * never provisioned          -> append at sequence 1
 *   * provisioned, same payload  -> replay (no second event, no widened authority)
 *   * provisioned, new payload   -> conflict; authority is changed by revoking
 *                                  and provisioning a *new* id, never by
 *                                  rewriting an existing record in place
 *   * revoked                    -> refused; revocation is terminal, so no
 *                                  retry ordering can resurrect it
 *
 * Revocation:
 *   * active                     -> append
 *   * already revoked            -> replay (idempotent; re-revoking is safe)
 *   * never provisioned          -> refused
 */
export function decideKernelAuthorityAppend(input: AppendKernelAuthorityEventInput, state: KernelAuthorityAppendState): KernelAuthorityAppendDecision {
  const payloadDigest = computeKernelAuthorityPayloadDigest(input.payload);
  const existing = state.existingEvents;
  const current = existing.length > 0 ? reconstructKernelAuthorityRecord(existing) : undefined;

  // An idempotency key is scoped to the organization and pinned to one payload.
  // A conflicting replay must never be silently merged into a second grant.
  if (input.idempotency !== undefined && state.idempotencyClaim !== undefined) {
    const claim = state.idempotencyClaim;
    if (claim.payloadDigest !== payloadDigest || claim.entityKind !== input.entityKind || claim.entityId !== input.entityId) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_IDEMPOTENCY_CONFLICT',
        `Idempotency key '${input.idempotency.idempotencyKey}' was already claimed in organization '${input.organizationId}' for a different payload (${claim.entityKind}:${claim.entityId}). Retrying a provisioning call with changed terms is refused rather than applied as a second grant.`,
      );
    }
    if (current !== undefined) {
      return { outcome: 'replay', record: current, payloadDigest };
    }
  }

  if (input.eventType === 'KernelAuthorityEntityProvisioned') {
    if (current === undefined) {
      if (state.conflictingExternalSubjectActorId !== undefined) {
        throw new KernelAuthorityError(
          'KERNEL_AUTHORITY_EXTERNAL_SUBJECT_CONFLICT',
          `The external subject declared for actor '${input.entityId}' is already bound to actor '${state.conflictingExternalSubjectActorId}' in organization '${input.organizationId}'. One external principal maps to exactly one Frontera actor per organization.`,
        );
      }
      return { outcome: 'append', sequence: 1, payloadDigest };
    }
    if (current.status === 'revoked') {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_ENTITY_REVOKED',
        `Kernel Authority entity '${input.entityKind}:${input.entityId}' in organization '${input.organizationId}' is revoked. Revocation is terminal: provision a new entity id rather than reusing a revoked one.`,
      );
    }
    if (computeKernelAuthorityPayloadDigest(current.payload) !== payloadDigest) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_ENTITY_CONFLICT',
        `Kernel Authority entity '${input.entityKind}:${input.entityId}' in organization '${input.organizationId}' is already provisioned with different terms. Authority is changed by revoking this entity and provisioning a new one, never by rewriting a record in place.`,
      );
    }
    return { outcome: 'replay', record: current, payloadDigest };
  }

  // Revocation.
  if (current === undefined) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_ENTITY_NOT_FOUND',
      `Cannot revoke Kernel Authority entity '${input.entityKind}:${input.entityId}' in organization '${input.organizationId}': it was never provisioned.`,
    );
  }
  if (current.status === 'revoked') {
    return { outcome: 'replay', record: current, payloadDigest };
  }
  const last = existing[existing.length - 1] as KernelAuthorityEvent;
  return { outcome: 'append', sequence: existing.length + 1, previousEventDigest: last.eventDigest, payloadDigest };
}
