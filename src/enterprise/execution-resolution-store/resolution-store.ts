import { deepFreeze } from '../governance-store/store-common.js';
import type {
  BindExecutionResolutionAuthorityInput,
  BindExecutionResolutionAuthorityResult,
  ExecutionResolutionAccessContext,
  ExecutionResolutionBinding,
  ExecutionResolutionRecord,
  ExecutionResolutionState,
  ExecutionResolutionStoreHealth,
  RecordExecutionResolutionInput,
  RecordExecutionResolutionResult,
} from './contracts.js';
import { ExecutionResolutionStoreError } from './errors.js';
import { executionResolutionBindingFailure, executionResolutionRecordFailure, sameExecutionResolution, sameExecutionResolutionBinding } from './integrity.js';
import { executionResolutionBindingViolation, executionResolutionViolation, isOpaqueResolutionIdentifier } from './validation.js';

/**
 * The read half. Returns state only after the binding, and the resolution when
 * one exists, verified against each other. A record that does not verify
 * throws `EXECUTION_RESOLUTION_CORRUPT`: a corrupted resolution never replays
 * as an answer and never returns capacity.
 */
export interface ExecutionResolutionReader {
  read(context: ExecutionResolutionAccessContext, executionId: string): Promise<ExecutionResolutionState | undefined>;
}

/**
 * The write half — append only. No update, no delete, no overwrite, no
 * unbind, no "latest wins".
 *
 * - `bind` — the same execution, attempt and authority returns the binding
 *   already recorded (`existing`); any other authority, or any other attempt,
 *   is `EXECUTION_RESOLUTION_CONFLICT`.
 * - `recordResolution` — requires the binding on record, by digest, attempt
 *   and authority (`EXECUTION_RESOLUTION_NOT_BOUND` otherwise): only the bound
 *   authority's answer can become a resolution. The identical definitive
 *   answer returns `existing`; a different one is
 *   `EXECUTION_RESOLUTION_CONFLICT`. One resolution per execution, never chosen
 *   by timestamp.
 */
export interface ExecutionResolutionWriter {
  bind(context: ExecutionResolutionAccessContext, input: BindExecutionResolutionAuthorityInput): Promise<BindExecutionResolutionAuthorityResult>;
  recordResolution(context: ExecutionResolutionAccessContext, input: RecordExecutionResolutionInput): Promise<RecordExecutionResolutionResult>;
}

export interface ExecutionResolutionPort extends ExecutionResolutionReader, ExecutionResolutionWriter {}

/**
 * The execution resolution store (P12).
 *
 * ## What an implementation must guarantee
 *
 * 1. **Atomic write decisions.** Each write reads the existing state, decides
 *    and writes in one critical section (SQLite: one `BEGIN IMMEDIATE`
 *    transaction; memory: one synchronous section). No network call is ever
 *    made inside it — the resolution authority is consulted before, outside.
 * 2. **Immutability.** A binding and a resolution, once written, are never
 *    updated or deleted (SQLite: triggers refuse both).
 * 3. **Deterministic identity.** The execution id is the identity of both.
 * 4. **Tenant confinement.** A call under another organization reads nothing
 *    and writes nothing.
 * 5. **Verify before trusting.** Every read, and every write that finds an
 *    existing row, re-validates and recomputes the digests first.
 * 6. **Fail closed, never repair.**
 */
export interface ExecutionResolutionStore extends ExecutionResolutionPort {
  readonly providerKind: 'memory' | 'sqlite';
  health(): Promise<ExecutionResolutionStoreHealth>;
  close(): Promise<void>;
}

export function requireResolutionAccessContext(context: ExecutionResolutionAccessContext): string {
  const organizationId = (context as { readonly organizationId?: unknown } | undefined)?.organizationId;
  const system = (context as { readonly system?: unknown } | undefined)?.system;
  if (!isOpaqueResolutionIdentifier(organizationId) || system !== undefined) {
    throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_TENANT_VIOLATION', 'An execution resolution call requires exactly one organization scope.');
  }
  return organizationId;
}

export function requireResolutionExecutionId(executionId: string): void {
  if (!isOpaqueResolutionIdentifier(executionId)) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_INPUT_INVALID', 'The execution id is not an opaque identifier.');
}

function corrupt(executionId: string, what: string): ExecutionResolutionStoreError {
  return new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_CORRUPT', `The persisted resolution state for execution '${executionId}' failed verification (${what}). Refused, never repaired.`);
}

function foreign(executionId: string): ExecutionResolutionStoreError {
  return new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_TENANT_VIOLATION', `The caller is not authorized to access execution '${executionId}'.`);
}

/**
 * The one verification every implementation runs over persisted state. The
 * organization check comes after integrity: a record that does not verify is
 * corrupt whoever asks, and a verified record of another organization is
 * refused without revealing anything about it.
 */
export function verifyLoadedResolutionState(
  executionId: string,
  organizationId: string,
  binding: ExecutionResolutionBinding | undefined,
  resolution: ExecutionResolutionRecord | undefined,
): ExecutionResolutionState | undefined {
  if (binding === undefined) {
    if (resolution !== undefined) throw corrupt(executionId, 'a resolution exists with no binding');
    return undefined;
  }
  if (binding.executionId !== executionId) throw corrupt(executionId, 'the binding is filed under another execution id');
  const bindingFailure = executionResolutionBindingFailure(binding);
  if (bindingFailure !== undefined) throw corrupt(executionId, bindingFailure);
  if (resolution !== undefined) {
    const resolutionFailure = executionResolutionRecordFailure(resolution, binding);
    if (resolutionFailure !== undefined) throw corrupt(executionId, resolutionFailure);
  }
  if (binding.organizationId !== organizationId) throw foreign(executionId);
  return deepFreeze(resolution === undefined ? { binding } : { binding, resolution });
}

export function requireValidBinding(context: ExecutionResolutionAccessContext, input: BindExecutionResolutionAuthorityInput): void {
  const organizationId = requireResolutionAccessContext(context);
  const violation = executionResolutionBindingViolation(input);
  if (violation !== undefined) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_INPUT_INVALID', `The resolution-authority binding is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_TENANT_VIOLATION', 'A binding for another organization cannot be recorded under this scope.');
}

export function requireValidResolution(context: ExecutionResolutionAccessContext, input: RecordExecutionResolutionInput): void {
  const organizationId = requireResolutionAccessContext(context);
  const violation = executionResolutionViolation(input);
  if (violation !== undefined) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_INPUT_INVALID', `The resolution is outside the closed contract: ${violation}.`);
  if (input.organizationId !== organizationId) throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_TENANT_VIOLATION', 'A resolution for another organization cannot be recorded under this scope.');
}

export type BindingPlan = { readonly kind: 'existing'; readonly binding: ExecutionResolutionBinding } | { readonly kind: 'bind' };

/** The one binding decision, taken inside the critical section over state read there. */
export function planExecutionResolutionBinding(input: BindExecutionResolutionAuthorityInput, existing: ExecutionResolutionState | undefined): BindingPlan {
  if (existing?.binding === undefined) return { kind: 'bind' };
  if (!sameExecutionResolutionBinding(existing.binding, input)) {
    throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_CONFLICT', `Execution '${input.executionId}' is already bound to a different resolution authority or attempt; the recorded binding stands.`);
  }
  return { kind: 'existing', binding: existing.binding };
}

export type ResolutionPlan = { readonly kind: 'existing'; readonly resolution: ExecutionResolutionRecord } | { readonly kind: 'record' };

/** The one resolution decision, taken inside the critical section over state read there. */
export function planExecutionResolution(input: RecordExecutionResolutionInput, existing: ExecutionResolutionState | undefined): ResolutionPlan {
  const binding = existing?.binding;
  if (binding === undefined || binding.bindingDigest !== input.bindingDigest || binding.attemptDigest !== input.attemptDigest || binding.authorityId !== input.authorityId) {
    throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_NOT_BOUND', `Execution '${input.executionId}' is not bound to this resolution authority and attempt; nothing was recorded.`);
  }
  if (existing?.resolution !== undefined) {
    if (!sameExecutionResolution(existing.resolution, input)) {
      throw new ExecutionResolutionStoreError('EXECUTION_RESOLUTION_CONFLICT', `Execution '${input.executionId}' already has a different definitive resolution; the recorded resolution stands.`);
    }
    return { kind: 'existing', resolution: existing.resolution };
  }
  return { kind: 'record' };
}
