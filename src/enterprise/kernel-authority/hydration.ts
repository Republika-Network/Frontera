import { ApprovalRuntime } from '../../features/approval-runtime/runtime/approval-runtime.js';
import type { ApprovalRuntimeContext } from '../../features/approval-runtime/runtime/approval-runtime-context.js';
import { createAuthorityGraphRuntime, type AuthorityGraphRuntime } from '../../features/authority-graph/runtime/authority-graph-runtime.js';
import type { AuthorityRuntimeContext } from '../../features/authority-graph/runtime/authority-runtime-context.js';
import { ExternalAgentHandshakeRuntime, createExternalAgentStandingIntegration } from '../../features/external-agent-handshake/runtime/index.js';
import type { HandshakeRuntimeContext } from '../../features/external-agent-handshake/runtime/handshake-runtime-context.js';
import { createAocRecognitionRuntime, type AocRecognitionRuntime } from '../../features/recognition-runtime/runtime/aoc-recognition-runtime.js';
import type { RuntimeContext as RecognitionRuntimeContext } from '../../features/recognition-runtime/runtime/runtime-context.js';
import type { KernelWorldHandles } from '../providers/kernel-provider-composition.js';
import type {
  KernelAuthorityRecord,
  ProvisionActorInput,
  ProvisionAuthorityGrantInput,
  ProvisionCapabilityTokenInput,
  ProvisionDelegationGrantInput,
  ProvisionPassportInput,
  ProvisionRootIssuerInput,
  ProvisionTrustDomainInput,
} from './contracts.js';
import { KernelAuthorityError } from './errors.js';
import { validateKernelAuthorityMonetaryConstraints } from './monetary-constraints.js';

export interface KernelAuthorityHydrationContext {
  readonly now: () => string;
  readonly nextId: (prefix: string) => string;
}

export interface KernelAuthorityHydrationResult extends KernelWorldHandles {
  /** Every record replayed into this world, in the order it was applied -- the evidence that the world is exactly the store's projection and nothing more. */
  readonly records: readonly KernelAuthorityRecord[];
}

/**
 * Replays a set of durable Kernel Authority records into a real, unmodified
 * Recognition Runtime / Authority Graph / Approval Runtime / External Agent
 * Handshake world.
 *
 * This is a **pure projection**. The world it returns is never a second source
 * of truth: it holds exactly what the store holds, is rebuilt from scratch
 * whenever the store changes, and contains nothing the store did not record.
 * Nothing is inferred, defaulted into existence, or auto-created -- a world
 * hydrated from an empty record set is the same empty, fail-closed world
 * `createDefaultKernelProviders()` builds.
 *
 * Records are applied in two passes, mirroring the event log they came from:
 * every entity is first replayed in the form it was *provisioned* in, then
 * every revocation is applied. A single pass would be wrong -- a delegation
 * grant whose source authority is now revoked could not be replayed at all,
 * and dropping it would silently lose the delegation record rather than
 * deny through it.
 *
 * Replay goes through the engines' own registration APIs -- the same ones the
 * engines' fixtures use -- so a hydrated actor is indistinguishable from a
 * directly-registered one and no Enterprise-specific shortcut into the
 * decision path exists.
 */
export function hydrateKernelAuthorityWorld(
  records: readonly KernelAuthorityRecord[],
  ctx: KernelAuthorityHydrationContext,
): KernelAuthorityHydrationResult {
  const authorityCtx: AuthorityRuntimeContext = { clock: { now: ctx.now }, ids: { nextId: ctx.nextId } };
  const authorityRuntime = createAuthorityGraphRuntime(authorityCtx);

  const approvalCtx: ApprovalRuntimeContext = { clock: { now: ctx.now }, ids: { nextId: ctx.nextId } };
  const approvalRuntime = new ApprovalRuntime(approvalCtx, { authorityGraph: authorityRuntime });

  const handshakeCtx: HandshakeRuntimeContext = { clock: { now: ctx.now }, ids: { nextId: ctx.nextId } };
  const handshakeRuntime = new ExternalAgentHandshakeRuntime(handshakeCtx);
  const externalAgentHandshake = createExternalAgentStandingIntegration(handshakeRuntime);

  const recognitionCtx: RecognitionRuntimeContext = { clock: { now: ctx.now }, idGenerator: { next: ctx.nextId } };
  const recognitionRuntime = createAocRecognitionRuntime(recognitionCtx, undefined, authorityRuntime, approvalRuntime, externalAgentHandshake);

  const applied: KernelAuthorityRecord[] = [];

  // Pass 1 -- replay every record as provisioned, in dependency order.
  //
  // Kind ordering alone is not enough. It gets actors and trust domains ahead
  // of the passports and tokens that reference them, and root issuers ahead of
  // the grants they authorize -- but it says nothing about dependencies
  // *within* a kind, and both grant kinds have them: an authority grant may
  // name a `parentGrantId`, and a delegation grant's `sourceAuthorityGrantId`
  // may name either a grant or another delegation. Ordering those by entity id
  // is ordering by a name, which has nothing to do with what depends on what:
  // a parent called `z-parent` would be replayed after its child `a-child`,
  // the engine would reject the child, and the whole world would fail to
  // hydrate -- permanently, on every restart, for a world an operator had
  // legitimately provisioned.
  for (const record of orderByDependency(records)) {
    applyProvisioned(record, recognitionRuntime, authorityRuntime);
    applied.push(record);
  }

  // Pass 2 -- apply revocations. Deliberately not an audited operation here:
  // hydration is a projection, and the durable audit trail of *who revoked
  // what and when* lives in the Kernel Authority Store's own event log.
  // Emitting a fresh evidence-ledger entry per restart would manufacture
  // history that never happened.
  for (const record of records) {
    if (record.status === 'revoked') applyRevocation(record, recognitionRuntime, authorityRuntime);
  }

  return { recognitionRuntime, authorityRuntime, approvalRuntime, handshakeRuntime, records: applied };
}

function payloadOf<T>(record: KernelAuthorityRecord): T {
  return record.payload as unknown as T;
}

/** The record this one must be replayed after, when it names one within its own kind. */
function intraKindDependencyOf(record: KernelAuthorityRecord): string | undefined {
  if (record.entityKind === 'authority-grant') {
    const parent = payloadOf<ProvisionAuthorityGrantInput>(record).parentGrantId;
    return typeof parent === 'string' && parent.length > 0 ? parent : undefined;
  }
  if (record.entityKind === 'delegation-grant') {
    // May point at an authority grant (already ordered earlier by kind) or at
    // another delegation (which is what actually needs ordering here).
    const source = payloadOf<ProvisionDelegationGrantInput>(record).sourceAuthorityGrantId;
    return typeof source === 'string' && source.length > 0 ? source : undefined;
  }
  return undefined;
}

/**
 * Stable topological order: kind order first (which the incoming sort already
 * establishes), then dependencies within each kind.
 *
 * Deliberately not a general graph sort over everything -- cross-kind ordering
 * is already correct and re-deriving it would risk changing it. This only
 * reorders records whose dependency sits in the same kind, and it preserves
 * the incoming relative order everywhere else so a hydration stays
 * byte-reproducible across processes.
 *
 * A cycle raises rather than silently dropping the records involved. Dropping
 * them would hydrate a world missing authority records without saying so,
 * which is the one failure mode this layer must never have -- a partial world
 * is not a narrower world, it is an unknown one.
 */
function orderByDependency(records: readonly KernelAuthorityRecord[]): readonly KernelAuthorityRecord[] {
  const byKindAndId = new Map<string, KernelAuthorityRecord>();
  for (const record of records) byKindAndId.set(`${record.entityKind} ${record.entityId}`, record);

  const ordered: KernelAuthorityRecord[] = [];
  const placed = new Set<KernelAuthorityRecord>();
  const visiting = new Set<KernelAuthorityRecord>();

  function place(record: KernelAuthorityRecord): void {
    if (placed.has(record)) return;
    if (visiting.has(record)) {
      throw new KernelAuthorityError(
        'KERNEL_AUTHORITY_REFERENCE_INVALID',
        `Kernel Authority records in organization '${record.organizationId}' form a dependency cycle at '${record.entityKind}:${record.entityId}'. Refusing to hydrate a world whose authority chain cannot be ordered.`,
        { entityKind: record.entityKind, entityId: record.entityId },
      );
    }
    visiting.add(record);
    const dependencyId = intraKindDependencyOf(record);
    if (dependencyId !== undefined) {
      const dependency = byKindAndId.get(`${record.entityKind} ${dependencyId}`);
      // Absent means the dependency is of another kind (already ordered
      // earlier) or genuinely missing -- the latter is the engine's to reject,
      // with its own precise message, when the record is replayed.
      if (dependency !== undefined) place(dependency);
    }
    visiting.delete(record);
    placed.add(record);
    ordered.push(record);
  }

  for (const record of records) place(record);
  return ordered;
}

function applyProvisioned(record: KernelAuthorityRecord, recognition: AocRecognitionRuntime, authority: AuthorityGraphRuntime): void {
  // P10: re-proven at hydration, not only at append. A record that reached the
  // log by any other route must not replay into usable monetary authority; the
  // whole world fails closed instead, exactly as for an engine-refused record.
  try {
    validateKernelAuthorityMonetaryConstraints(record.entityKind, record.payload, `Kernel Authority record '${record.entityKind}:${record.entityId}' in organization '${record.organizationId}'`);
  } catch (error) {
    throw new KernelAuthorityError('KERNEL_AUTHORITY_INTEGRITY_FAILED', error instanceof Error ? error.message : String(error), { entityKind: record.entityKind, entityId: record.entityId });
  }
  try {
    switch (record.entityKind) {
      case 'actor': {
        const input = payloadOf<ProvisionActorInput>(record);
        recognition.registerActor({
          id: input.actorId,
          type: input.type,
          displayName: input.displayName,
          ...(input.issuerId !== undefined ? { issuerId: input.issuerId } : {}),
          ...(input.trustDomainId !== undefined ? { trustDomainId: input.trustDomainId } : {}),
          ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
          ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        });
        return;
      }
      case 'trust-domain': {
        const input = payloadOf<ProvisionTrustDomainInput>(record);
        recognition.createTrustDomain({
          id: input.trustDomainId,
          name: input.name,
          issuerActorId: input.issuerActorId,
          acceptedIssuerIds: input.acceptedIssuerIds,
          acceptedActorTypes: input.acceptedActorTypes,
          ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
          ...(input.policyPackIds !== undefined ? { policyPackIds: input.policyPackIds } : {}),
        });
        return;
      }
      case 'passport': {
        const input = payloadOf<ProvisionPassportInput>(record);
        recognition.issuePassport({
          id: input.passportId,
          type: input.type,
          subjectActorId: input.subjectActorId,
          issuerActorId: input.issuerActorId,
          trustDomainId: input.trustDomainId,
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        });
        return;
      }
      case 'capability-token': {
        const input = payloadOf<ProvisionCapabilityTokenInput>(record);
        recognition.issueCapabilityToken({
          id: input.capabilityTokenId,
          subjectActorId: input.subjectActorId,
          principalActorId: input.principalActorId,
          issuerActorId: input.issuerActorId,
          trustDomainId: input.trustDomainId,
          capability: input.capability,
          actions: input.actions,
          resourceScopes: input.resourceScopes,
          riskLevel: input.riskLevel,
          ...(input.evidenceRequirements !== undefined ? { evidenceRequirements: input.evidenceRequirements } : {}),
          ...(input.approvalRequirement !== undefined ? { approvalRequirement: input.approvalRequirement } : {}),
          ...(input.prohibitedActions !== undefined ? { prohibitedActions: input.prohibitedActions } : {}),
          ...(input.delegable !== undefined ? { delegable: input.delegable } : {}),
          ...(input.maxDelegationDepth !== undefined ? { maxDelegationDepth: input.maxDelegationDepth } : {}),
          ...(input.jurisdiction !== undefined ? { jurisdiction: input.jurisdiction } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
        });
        return;
      }
      case 'root-issuer': {
        const input = payloadOf<ProvisionRootIssuerInput>(record);
        authority.registerRootIssuer(input.trustDomainId, input.actorId);
        return;
      }
      case 'authority-grant': {
        const input = payloadOf<ProvisionAuthorityGrantInput>(record);
        authority.issueAuthorityGrant({
          id: input.authorityGrantId,
          issuerActorId: input.issuerActorId,
          subjectActorId: input.subjectActorId,
          trustDomainId: input.trustDomainId,
          capability: input.capability,
          actions: input.actions,
          resourceScopes: input.resourceScopes,
          ...(input.roleId !== undefined ? { roleId: input.roleId } : {}),
          ...(input.canDelegate !== undefined ? { canDelegate: input.canDelegate } : {}),
          ...(input.allowedDelegateActorTypes !== undefined ? { allowedDelegateActorTypes: input.allowedDelegateActorTypes } : {}),
          ...(input.maxDelegationDepth !== undefined ? { maxDelegationDepth: input.maxDelegationDepth } : {}),
          ...(input.nonDelegableActions !== undefined ? { nonDelegableActions: input.nonDelegableActions } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.parentGrantId !== undefined ? { parentGrantId: input.parentGrantId } : {}),
          // P10: monetary authority survives the round trip exactly as provisioned.
          ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
        });
        return;
      }
      case 'delegation-grant': {
        const input = payloadOf<ProvisionDelegationGrantInput>(record);
        authority.createDelegationGrant({
          id: input.delegationGrantId,
          delegatorActorId: input.delegatorActorId,
          delegateActorId: input.delegateActorId,
          delegateActorType: input.delegateActorType,
          trustDomainId: input.trustDomainId,
          sourceAuthorityGrantId: input.sourceAuthorityGrantId,
          capability: input.capability,
          actions: input.actions,
          resourceScopes: input.resourceScopes,
          ...(input.principalActorId !== undefined ? { principalActorId: input.principalActorId } : {}),
          ...(input.canRedelegate !== undefined ? { canRedelegate: input.canRedelegate } : {}),
          ...(input.nonDelegableActions !== undefined ? { nonDelegableActions: input.nonDelegableActions } : {}),
          ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
          ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
        });
        return;
      }
      default: {
        const exhaustive: never = record.entityKind;
        throw new KernelAuthorityError('KERNEL_AUTHORITY_INTEGRITY_FAILED', `Unhandled Kernel Authority entity kind '${String(exhaustive)}'.`);
      }
    }
  } catch (error) {
    if (error instanceof KernelAuthorityError) throw error;
    // A record the engine itself refuses is untrustworthy authority state: a
    // capability token naming an actor that is not there, a delegation whose
    // source grant is missing. Startup fails rather than quietly hydrating a
    // partial world -- a world missing the records it could not apply is not a
    // narrower world, it is an unknown one.
    throw new KernelAuthorityError(
      'KERNEL_AUTHORITY_REFERENCE_INVALID',
      `Kernel Authority record '${record.entityKind}:${record.entityId}' in organization '${record.organizationId}' could not be replayed into the decision engine: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { entityKind: record.entityKind, entityId: record.entityId },
    );
  }
}

function applyRevocation(record: KernelAuthorityRecord, recognition: AocRecognitionRuntime, authority: AuthorityGraphRuntime): void {
  switch (record.entityKind) {
    case 'actor':
      recognition.actorRegistry.updateActorStatus(record.entityId, 'revoked');
      return;
    case 'passport':
      recognition.passportService.revokePassport(record.entityId);
      return;
    case 'capability-token':
      recognition.capabilityTokenService.revokeCapabilityToken(record.entityId);
      return;
    case 'authority-grant':
      authority.store.updateGrantStatus(record.entityId, 'revoked');
      return;
    case 'delegation-grant':
      authority.store.updateDelegationStatus(record.entityId, 'revoked');
      return;
    case 'trust-domain':
    case 'root-issuer':
      // A revoked trust domain or root issuer is simply not replayed as live
      // authority: everything scoped to it was refused replay in pass 1 only
      // if the engine rejected it, so the truthful narrowing here is that the
      // provisioning service refuses to revoke these kinds at all. See
      // `provisioning-service.ts`'s `REVOCABLE_ENTITY_KINDS`.
      return;
    default: {
      const exhaustive: never = record.entityKind;
      throw new KernelAuthorityError('KERNEL_AUTHORITY_INTEGRITY_FAILED', `Unhandled Kernel Authority entity kind '${String(exhaustive)}'.`);
    }
  }
}
