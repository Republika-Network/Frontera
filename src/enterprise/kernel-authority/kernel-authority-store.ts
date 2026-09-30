import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { computeDigest } from '../governance-store/digest.js';
import {
  KERNEL_AUTHORITY_ENTITY_KINDS,
  KERNEL_AUTHORITY_SCHEMA_VERSION,
  type AppendKernelAuthorityEventInput,
  type AppendKernelAuthorityEventResult,
  type KernelAuthorityAccessContext,
  type KernelAuthorityEntityKind,
  type KernelAuthorityEvent,
  type KernelAuthorityExternalSubject,
  type KernelAuthorityRecord,
  type KernelAuthorityRecordQuery,
  type KernelAuthorityStoreHealth,
  type KernelAuthorityStoreProviderKind,
} from './contracts.js';
import { KernelAuthorityError } from './errors.js';

/**
 * The Kernel Authority Store: an independent, durable store for the
 * operator-provisioned recognition/authority world, never persisted inside
 * the Governance Store, the Evidence Bundle Store, the Agent Passport Store,
 * the Assurance Store, the Governed Authority Store, or a UI-only table.
 *
 * There is deliberately no `update`/`delete`: every change is an appended
 * event (`appendEvent`) and current state is always reconstructed
 * (`getRecord`/`listRecords`), never read from a mutable row treated as
 * authoritative. Historical authority records are never rewritten.
 *
 * The store answers *what was provisioned*. It never answers *whether an
 * action may proceed* -- that question belongs to `AocKernel.evaluate()` and
 * to nothing else in this layer.
 */
export interface KernelAuthorityStore {
  readonly providerKind: KernelAuthorityStoreProviderKind;

  /**
   * Appends one authority event atomically, enforcing the provisioning rules
   * before commit: an entity id is provisioned once (a second provision with
   * a different payload is a conflict, never a silent widening), a revoked
   * entity is terminal and is never resurrected by a retry, and an
   * idempotency key is honoured exactly once per payload.
   *
   * Requires an operator context (`context.system === true`). An evaluation
   * never holds one.
   */
  appendEvent(context: KernelAuthorityAccessContext, input: AppendKernelAuthorityEventInput): Promise<AppendKernelAuthorityEventResult>;

  /** Reconstructs one entity's current state from its event chain, or `null` when it was never provisioned. */
  getRecord(
    context: KernelAuthorityAccessContext,
    organizationId: string,
    entityKind: KernelAuthorityEntityKind,
    entityId: string,
  ): Promise<KernelAuthorityRecord | null>;

  /** Reconstructs every record matching `query`, ordered deterministically by `(entityKind, entityId)` so a hydration is stable across processes. */
  listRecords(context: KernelAuthorityAccessContext, query: KernelAuthorityRecordQuery): Promise<readonly KernelAuthorityRecord[]>;

  /** The immutable audit trail for one entity, oldest first. */
  listEvents(
    context: KernelAuthorityAccessContext,
    organizationId: string,
    entityKind: KernelAuthorityEntityKind,
    entityId: string,
  ): Promise<readonly KernelAuthorityEvent[]>;

  /**
   * Resolves an external application principal to the Frontera actor it is
   * bound to, or `null`. A read -- it never creates a binding, and a caller
   * that resolves nothing gets nothing rather than a freshly minted actor.
   */
  findActorByExternalSubject(
    context: KernelAuthorityAccessContext,
    organizationId: string,
    externalSubject: KernelAuthorityExternalSubject,
  ): Promise<KernelAuthorityRecord | null>;

  health(): Promise<KernelAuthorityStoreHealth>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Tenancy + role guards. Mirrors `passport-store.ts`'s helpers exactly.
// ---------------------------------------------------------------------------

/** True when `context` may *read* a record scoped to `recordOrganizationId`. */
export function canAccessKernelAuthorityOrganization(context: KernelAuthorityAccessContext, recordOrganizationId: string): boolean {
  if (context.system) return true;
  return context.organizationId !== undefined && context.organizationId === recordOrganizationId;
}

export function requireKernelAuthorityTenantScope(context: KernelAuthorityAccessContext): void {
  if (!context.system && (context.organizationId === undefined || context.organizationId.length === 0)) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_TENANT_SCOPE_REQUIRED', 'A non-system caller must provide an organization scope for Kernel Authority access.');
  }
}

export function requireKernelAuthorityReadAccess(context: KernelAuthorityAccessContext, organizationId: string): void {
  requireKernelAuthorityTenantScope(context);
  if (!canAccessKernelAuthorityOrganization(context, organizationId)) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_ACCESS_SCOPE_VIOLATION',
      `The caller is not authorized to read Kernel Authority state for organization '${organizationId}'.`,
    );
  }
}

/**
 * Writes require the privileged operator context and nothing less.
 *
 * This is the single line that makes "an application cannot provision itself
 * during evaluation" a structural property rather than a convention: an
 * evaluation reads with an ordinary organization-scoped context, and no
 * organization-scoped context can ever reach this function's success path.
 * Mirrors `AuthorityGovernanceContext`'s `system: true` rule for
 * `bootstrapPosition`.
 */
export function requireKernelAuthorityOperator(context: KernelAuthorityAccessContext): string {
  if (context.system !== true) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED',
      'Provisioning or revoking Kernel Authority state requires a privileged operator context (system: true). Evaluation contexts are read-only by design.',
    );
  }
  const operatorId = context.actorId;
  if (operatorId === undefined || operatorId.trim().length === 0) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_OPERATOR_CONTEXT_REQUIRED',
      'An operator context must name the operator performing the write (context.actorId), so the durable audit trail can record who provisioned it.',
    );
  }
  return operatorId;
}

// ---------------------------------------------------------------------------
// Shared event/projection mechanics, used identically by both implementations
// so memory and SQLite can never disagree about digests, ordering or rules.
// ---------------------------------------------------------------------------

export function isKernelAuthorityEntityKind(value: string): value is KernelAuthorityEntityKind {
  return (KERNEL_AUTHORITY_ENTITY_KINDS as readonly string[]).includes(value);
}

/** Stable digest of a provisioning payload -- the value an idempotency replay is compared against. Uses the runtime's own `aoc.canonical-json.v1`, never a second canonicalization. */
export function computeKernelAuthorityPayloadDigest(payload: Readonly<Record<string, unknown>>): string {
  return computeDigest(canonicalSerialize(payload));
}

export interface BuildKernelAuthorityEventInput {
  readonly eventId: string;
  readonly organizationId: string;
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly eventType: KernelAuthorityEvent['eventType'];
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provisionedBy: string;
  readonly occurredAt: string;
  readonly persistedAt: string;
  readonly previousEventDigest?: string;
  readonly runtimeVersion: string;
}

/**
 * Computes an event's digest from its own fields.
 *
 * The single definition used both when an event is written and when one read
 * back is verified. Two implementations would be worse than none: a verifier
 * that drifted from the writer would either reject every honest event or --
 * far worse -- accept a dishonest one.
 */
export function computeKernelAuthorityEventDigest(event: Omit<KernelAuthorityEvent, 'eventDigest'>): string {
  const unsigned = {
    eventId: event.eventId,
    organizationId: event.organizationId,
    entityKind: event.entityKind,
    entityId: event.entityId,
    eventType: event.eventType,
    sequence: event.sequence,
    payload: event.payload,
    provisionedBy: event.provisionedBy,
    occurredAt: event.occurredAt,
    persistedAt: event.persistedAt,
    schemaVersion: event.schemaVersion,
    runtimeVersion: event.runtimeVersion,
    ...(event.previousEventDigest !== undefined ? { previousEventDigest: event.previousEventDigest } : {}),
  };
  return computeDigest(canonicalSerialize(unsigned));
}

/**
 * Builds one event and its chain digest. The digest covers the event's own
 * payload *and* the previous digest, so both a tampered payload and a
 * reordered history are detectable, and an entity's chain names exactly which
 * prior state each event superseded.
 */
export function buildKernelAuthorityEvent(input: BuildKernelAuthorityEventInput): KernelAuthorityEvent {
  const unsigned: Omit<KernelAuthorityEvent, 'eventDigest'> = {
    eventId: input.eventId,
    organizationId: input.organizationId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    eventType: input.eventType,
    sequence: input.sequence,
    payload: input.payload,
    provisionedBy: input.provisionedBy,
    occurredAt: input.occurredAt,
    persistedAt: input.persistedAt,
    schemaVersion: KERNEL_AUTHORITY_SCHEMA_VERSION,
    runtimeVersion: input.runtimeVersion,
    ...(input.previousEventDigest !== undefined ? { previousEventDigest: input.previousEventDigest } : {}),
  };
  return { ...unsigned, eventDigest: computeKernelAuthorityEventDigest(unsigned) };
}

/**
 * The chain head an entity's events are expected to reconstruct to.
 *
 * Supplied by a store that keeps an independently-written record of the head
 * (the SQLite projection row). Without it, a chain whose *tail* was lost is
 * indistinguishable from a chain that was always shorter: the surviving prefix
 * is perfectly self-consistent, so neither sequence contiguity nor digest
 * linkage notices anything wrong -- and a lost revocation event would read
 * back as live authority.
 */
export interface KernelAuthorityChainHead {
  readonly latestSequence: number;
  readonly latestEventDigest: string;
}

/**
 * Reconstructs an entity's current state from its ordered event chain.
 *
 * Fails closed on a history it cannot trust: a chain that does not begin with
 * a provisioning event, or whose sequence numbers are not contiguous, or
 * whose digest linkage is broken, raises rather than being partially
 * interpreted. Silently discarding an unintelligible event and continuing
 * would be exactly the widening failure mode this layer must not have -- a
 * dropped revocation event would resurrect authority.
 */
export function reconstructKernelAuthorityRecord(events: readonly KernelAuthorityEvent[], expectedHead?: KernelAuthorityChainHead): KernelAuthorityRecord {
  const first = events[0];
  if (first === undefined) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_INTEGRITY_FAILED', 'Cannot reconstruct a Kernel Authority record from an empty event chain.');
  }
  if (first.eventType !== 'KernelAuthorityEntityProvisioned') {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_INTEGRITY_FAILED',
      `Kernel Authority event chain for '${first.entityKind}:${first.entityId}' does not begin with a provisioning event (found '${first.eventType}').`,
    );
  }

  let status: KernelAuthorityRecord['status'] = 'active';
  let revokedBy: string | undefined;
  let revokedAt: string | undefined;
  let revocationReason: string | undefined;
  let previousDigest: string | undefined;

  for (const [index, event] of events.entries()) {
    if (event.sequence !== index + 1) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_INTEGRITY_FAILED',
        `Kernel Authority event chain for '${event.entityKind}:${event.entityId}' has a sequence gap at position ${index + 1} (found sequence ${event.sequence}).`,
      );
    }
    if (event.previousEventDigest !== previousDigest) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_INTEGRITY_FAILED',
        `Kernel Authority event chain for '${event.entityKind}:${event.entityId}' is broken at sequence ${event.sequence}: the recorded previous digest does not match the preceding event.`,
      );
    }
    // Recomputed, never trusted. Checking only that the *next* event cites this
    // event's stored digest proves the events are in the order someone wrote
    // them down -- it proves nothing about whether the payload still says what
    // it said when it was signed. Editing a capability token's actions in place
    // and leaving the digest columns alone passes that weaker check.
    const recomputed = computeKernelAuthorityEventDigest(event);
    if (recomputed !== event.eventDigest) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_INTEGRITY_FAILED',
        `Kernel Authority event '${event.eventId}' (${event.entityKind}:${event.entityId} sequence ${event.sequence}) does not match its recorded digest: the persisted event has been altered since it was written.`,
      );
    }
    previousDigest = event.eventDigest;

    if (event.eventType === 'KernelAuthorityEntityRevoked') {
      status = 'revoked';
      revokedBy = event.provisionedBy;
      revokedAt = event.occurredAt;
      const reason = event.payload.reason;
      revocationReason = typeof reason === 'string' ? reason : undefined;
    }
  }

  const latest = events[events.length - 1] as KernelAuthorityEvent;

  if (expectedHead !== undefined && (latest.sequence !== expectedHead.latestSequence || latest.eventDigest !== expectedHead.latestEventDigest)) {
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_INTEGRITY_FAILED',
      `Kernel Authority event chain for '${latest.entityKind}:${latest.entityId}' ends at sequence ${latest.sequence}, but the store records its head at sequence ${expectedHead.latestSequence}. Events are missing from the end of the chain; refusing to interpret the surviving prefix, which would read back as live authority.`,
    );
  }

  const trustDomainId = extractTrustDomainId(first.entityKind, first.entityId, first.payload);

  return {
    organizationId: first.organizationId,
    entityKind: first.entityKind,
    entityId: first.entityId,
    status,
    payload: first.payload,
    provisionedBy: first.provisionedBy,
    provisionedAt: first.occurredAt,
    latestSequence: latest.sequence,
    latestEventDigest: latest.eventDigest,
    ...(trustDomainId !== undefined ? { trustDomainId } : {}),
    ...(revokedBy !== undefined ? { revokedBy } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(revocationReason !== undefined ? { revocationReason } : {}),
  };
}

/**
 * The trust domain a record belongs to -- the Kernel's own enforcement
 * boundary, indexed so a hydration can load exactly one domain's world.
 *
 * A `trust-domain` record *is* the boundary, so its own id is the answer; a
 * `root-issuer` record is keyed by the domain it roots. An `actor` record may
 * legitimately carry none (an organization actor that issues into a domain it
 * is not itself a member of), and `undefined` there means "not domain-scoped",
 * never "every domain".
 */
function extractTrustDomainId(kind: KernelAuthorityEntityKind, entityId: string, payload: Readonly<Record<string, unknown>>): string | undefined {
  if (kind === 'trust-domain') return entityId;
  const value = payload.trustDomainId;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Deterministic ordering for a hydration set: kind first (in declared dependency order), then entity id. */
export function compareKernelAuthorityRecords(a: KernelAuthorityRecord, b: KernelAuthorityRecord): number {
  const kindDelta = KERNEL_AUTHORITY_ENTITY_KINDS.indexOf(a.entityKind) - KERNEL_AUTHORITY_ENTITY_KINDS.indexOf(b.entityKind);
  if (kindDelta !== 0) return kindDelta;
  return a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
}

/** Reads the explicit external-subject binding off an `actor` provisioning payload, or `undefined`. Never guesses one out of `metadata`. */
export function readExternalSubject(payload: Readonly<Record<string, unknown>>): KernelAuthorityExternalSubject | undefined {
  const raw = payload.externalSubject;
  if (raw === null || typeof raw !== 'object') return undefined;
  const { system, subjectId } = raw as Record<string, unknown>;
  if (typeof system !== 'string' || system.length === 0) return undefined;
  if (typeof subjectId !== 'string' || subjectId.length === 0) return undefined;
  return { system, subjectId };
}

export function externalSubjectKey(organizationId: string, externalSubject: KernelAuthorityExternalSubject): string {
  return `${organizationId} ${externalSubject.system} ${externalSubject.subjectId}`;
}
