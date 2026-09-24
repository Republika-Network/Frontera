import {
  type KernelAuthorityAccessContext,
  type KernelAuthorityEntityKind,
  type KernelAuthorityEvent,
  type KernelAuthorityExternalSubject,
  type KernelAuthorityIdempotency,
  type KernelAuthorityRecord,
  type ProvisionActorInput,
  type ProvisionAuthorityGrantInput,
  type ProvisionCapabilityTokenInput,
  type ProvisionDelegationGrantInput,
  type ProvisionPassportInput,
  type ProvisionRootIssuerInput,
  type ProvisionTrustDomainInput,
} from './contracts.js';
import type { MonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { KernelAuthorityError } from './errors.js';
import { assertKernelAuthorityMonetaryConstraintsWithinRegistry } from './monetary-constraints.js';
import type { KernelAuthorityStore } from './kernel-authority-store.js';

/**
 * Entity kinds a revocation is meaningful for.
 *
 * A trust domain and a root issuer are deliberately excluded. Revoking either
 * would not narrow authority truthfully -- it would leave every actor,
 * passport, token and grant inside that domain replayed as live while the
 * boundary they hang from silently vanished, which is a *widening* of what the
 * remaining state appears to mean. Retiring a trust domain is done by revoking
 * the authority inside it, so that every denial names the credential it
 * actually failed on.
 */
const REVOCABLE_ENTITY_KINDS: readonly KernelAuthorityEntityKind[] = ['actor', 'passport', 'capability-token', 'authority-grant', 'delegation-grant'];

export interface KernelAuthorityProvisioningOptions {
  readonly idempotency?: KernelAuthorityIdempotency;
  /** Overrides the recorded event time. Operators normally leave this to the store's clock. */
  readonly occurredAt?: string;
}

export interface KernelAuthorityRevocationInput {
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly reason: string;
}

export interface KernelAuthorityProvisioningResult {
  readonly record: KernelAuthorityRecord;
  /** `true` when an idempotent retry returned the original record and appended nothing. */
  readonly replayed: boolean;
}

/**
 * The operator provisioning surface for the durable Kernel Authority world.
 *
 * **This is a trusted operator surface.** It is the write half of the
 * provisioning/evaluation separation this increment exists to establish, and
 * it must be handed only to operator/administration code -- a CLI, a
 * deployment bootstrap, an authenticated administrative route. It must never
 * be reachable from a request handler that serves evaluations, and no object a
 * downstream application receives should carry a reference to it.
 *
 * Every method here requires `context.system === true` *and* an operator
 * identity, enforced in the store itself rather than here, so the guarantee
 * holds even for a caller that bypasses this service and writes to the store
 * directly.
 *
 * The service provisions; it never decides. Nothing it writes is an
 * authorization outcome, and it has no way to express one.
 */
export interface KernelAuthorityProvisioningService {
  readonly organizationId: string;

  provisionActor(context: KernelAuthorityAccessContext, input: ProvisionActorInput, options?: KernelAuthorityProvisioningOptions): Promise<KernelAuthorityProvisioningResult>;
  provisionTrustDomain(
    context: KernelAuthorityAccessContext,
    input: ProvisionTrustDomainInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;
  provisionPassport(
    context: KernelAuthorityAccessContext,
    input: ProvisionPassportInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;
  provisionCapabilityToken(
    context: KernelAuthorityAccessContext,
    input: ProvisionCapabilityTokenInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;
  provisionRootIssuer(
    context: KernelAuthorityAccessContext,
    input: ProvisionRootIssuerInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;
  provisionAuthorityGrant(
    context: KernelAuthorityAccessContext,
    input: ProvisionAuthorityGrantInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;
  provisionDelegationGrant(
    context: KernelAuthorityAccessContext,
    input: ProvisionDelegationGrantInput,
    options?: KernelAuthorityProvisioningOptions,
  ): Promise<KernelAuthorityProvisioningResult>;

  /** Revokes one provisioned entity. Terminal: a revoked entity is never re-provisioned under the same id, in this process or after any restart. */
  revoke(context: KernelAuthorityAccessContext, input: KernelAuthorityRevocationInput, options?: KernelAuthorityProvisioningOptions): Promise<KernelAuthorityProvisioningResult>;

  /** Read surface for administration and audit -- the immutable trail of who provisioned what, when, and what it superseded. */
  listEvents(context: KernelAuthorityAccessContext, entityKind: KernelAuthorityEntityKind, entityId: string): Promise<readonly KernelAuthorityEvent[]>;
  listRecords(context: KernelAuthorityAccessContext): Promise<readonly KernelAuthorityRecord[]>;
  /** Resolves an external application principal to the Frontera actor bound to it, or `null`. Read-only: an unbound principal stays unbound. */
  findActorByExternalSubject(context: KernelAuthorityAccessContext, externalSubject: KernelAuthorityExternalSubject): Promise<KernelAuthorityRecord | null>;
}

export interface CreateKernelAuthorityProvisioningServiceOptions {
  readonly store: KernelAuthorityStore;
  readonly organizationId: string;
  /**
   * A live durable provider set to keep in step with the store.
   *
   * When supplied, every committed write is followed by a re-hydration of that
   * world from the store, so a single-process deployment's decisions reflect a
   * provisioning call immediately. The store is re-read rather than the world
   * patched: the world stays a pure projection, and the two can never diverge
   * through a partially-applied mutation.
   */
  readonly onCommitted?: () => Promise<void>;
  /**
   * P10 — the deployment's trusted asset registry. When supplied, monetary
   * authority constraints are refused at provisioning unless every asset they
   * name is recognized and every value fits that asset's trusted scale, so an
   * obvious configuration fault never waits for a live payment to surface.
   * (Resolution re-checks regardless, and fails closed.)
   */
  readonly monetaryAssets?: MonetaryAssetRegistry;
}

export function createKernelAuthorityProvisioningService(
  options: CreateKernelAuthorityProvisioningServiceOptions,
): KernelAuthorityProvisioningService {
  const { store, organizationId, onCommitted, monetaryAssets } = options;

  function checkMonetary(constraints: ProvisionAuthorityGrantInput['constraints']): void {
    if (monetaryAssets !== undefined) assertKernelAuthorityMonetaryConstraintsWithinRegistry(constraints, monetaryAssets);
  }

  async function append(
    context: KernelAuthorityAccessContext,
    entityKind: KernelAuthorityEntityKind,
    entityId: string,
    eventType: KernelAuthorityEvent['eventType'],
    payload: Readonly<Record<string, unknown>>,
    provisioningOptions: KernelAuthorityProvisioningOptions | undefined,
  ): Promise<KernelAuthorityProvisioningResult> {
    if (!entityId || entityId.trim().length === 0) {
      throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', `A ${entityKind} must be provisioned with a non-empty id.`);
    }
    const result = await store.appendEvent(context, {
      organizationId,
      entityKind,
      entityId,
      eventType,
      payload,
      ...(provisioningOptions?.occurredAt !== undefined ? { occurredAt: provisioningOptions.occurredAt } : {}),
      ...(provisioningOptions?.idempotency !== undefined ? { idempotency: provisioningOptions.idempotency } : {}),
    });
    // Only after the store has committed. A re-hydration that ran first could
    // publish authority the durable source never accepted.
    if (!result.replayed && onCommitted !== undefined) await onCommitted();
    return { record: result.record, replayed: result.replayed };
  }

  /** Drops `undefined`-valued keys so a payload digest is stable across callers that spell an absent option differently. */
  function normalize(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
  }

  return {
    organizationId,

    provisionActor(context, input, provisioningOptions) {
      return append(context, 'actor', input.actorId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    provisionTrustDomain(context, input, provisioningOptions) {
      return append(context, 'trust-domain', input.trustDomainId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    provisionPassport(context, input, provisioningOptions) {
      return append(context, 'passport', input.passportId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    provisionCapabilityToken(context, input, provisioningOptions) {
      return append(context, 'capability-token', input.capabilityTokenId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    provisionRootIssuer(context, input, provisioningOptions) {
      // Keyed by `(trustDomain, actor)` so a domain can have more than one root
      // issuer without one silently replacing another.
      return append(
        context,
        'root-issuer',
        `${input.trustDomainId}::${input.actorId}`,
        'KernelAuthorityEntityProvisioned',
        normalize({ ...input }),
        provisioningOptions,
      );
    },

    async provisionAuthorityGrant(context, input, provisioningOptions) {
      checkMonetary(input.constraints);
      return append(context, 'authority-grant', input.authorityGrantId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    async provisionDelegationGrant(context, input, provisioningOptions) {
      checkMonetary(input.constraints);
      return append(context, 'delegation-grant', input.delegationGrantId, 'KernelAuthorityEntityProvisioned', normalize({ ...input }), provisioningOptions);
    },

    // `async` so a guard failure surfaces as a rejected promise like every
    // other failure on this surface, rather than as a synchronous throw a
    // caller would have to handle a second way.
    async revoke(context, input, provisioningOptions) {
      if (!REVOCABLE_ENTITY_KINDS.includes(input.entityKind)) {
        throw new KernelAuthorityError(
          'KERNEL_AUTHORITY_VALIDATION_ERROR',
          `Kernel Authority entities of kind '${input.entityKind}' are not revocable. Revoke the actors, passports, capability tokens and grants scoped to it instead, so every denial names the credential it actually failed on.`,
        );
      }
      if (!input.reason || input.reason.trim().length === 0) {
        throw new KernelAuthorityError('KERNEL_AUTHORITY_VALIDATION_ERROR', 'A revocation must record a reason, so the durable audit trail explains why authority was withdrawn.');
      }
      return append(context, input.entityKind, input.entityId, 'KernelAuthorityEntityRevoked', { reason: input.reason }, provisioningOptions);
    },

    listEvents(context, entityKind, entityId) {
      return store.listEvents(context, organizationId, entityKind, entityId);
    },

    listRecords(context) {
      return store.listRecords(context, { organizationId });
    },

    findActorByExternalSubject(context, externalSubject) {
      return store.findActorByExternalSubject(context, organizationId, externalSubject);
    },
  };
}
