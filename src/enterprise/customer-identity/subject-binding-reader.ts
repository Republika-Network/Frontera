import type { KernelAuthorityStore } from '../kernel-authority/kernel-authority-store.js';
import type { CustomerExternalSubject } from './contracts.js';

/**
 * What the binding source says about one external subject in one organization.
 *
 * `unbound` and `revoked` are answers. An **unanswerable** question is not one
 * of these: a reader that cannot read throws, and admission turns the throw
 * into `unavailable` — never into `unbound`, and never into an actor.
 */
export type CustomerSubjectBinding =
  | { readonly status: 'bound'; readonly actorId: string }
  | { readonly status: 'revoked'; readonly actorId: string }
  | { readonly status: 'unbound' }
  | { readonly status: 'inconsistent' };

/**
 * The read-only port customer admission is handed instead of the Kernel
 * Authority store.
 *
 * One method, and it reads. Nothing reachable through it provisions an actor,
 * issues a passport, capability token, authority grant or delegation, or
 * revokes anything: the full store — and the operator context its writes
 * require — never enters the customer-identity layer.
 */
export interface CustomerSubjectBindingReader {
  findActorByExternalSubject(organizationId: string, externalSubject: CustomerExternalSubject): Promise<CustomerSubjectBinding>;
}

/**
 * The only production binding reader: the Kernel Authority's own
 * `(organizationId, system, subjectId)` index. There is no second binding
 * table, map or file.
 *
 * It reads with an **organization-scoped, non-system** context — the same
 * least-privileged read an evaluation uses — so the store's own tenancy guard
 * (`requireKernelAuthorityReadAccess`) refuses a read of any other
 * organization's bindings. The customer is never handed that context, and the
 * reader never needs `system: true`.
 *
 * The record the store returns is then checked against the question that was
 * asked. A record of the wrong kind, organization or subject is not an actor
 * this subject is bound to; it is a store that answered a different question,
 * and it admits no one.
 */
export function createKernelAuthoritySubjectBindingReader(store: Pick<KernelAuthorityStore, 'findActorByExternalSubject'>): CustomerSubjectBindingReader {
  return {
    async findActorByExternalSubject(organizationId, externalSubject) {
      const record = await store.findActorByExternalSubject({ system: false, organizationId }, organizationId, {
        system: externalSubject.system,
        subjectId: externalSubject.subjectId,
      });
      if (record === null) return { status: 'unbound' };

      const bound = record.payload.externalSubject as { readonly system?: unknown; readonly subjectId?: unknown } | null | undefined;
      if (
        record.entityKind !== 'actor' ||
        record.organizationId !== organizationId ||
        typeof record.entityId !== 'string' ||
        record.entityId.length === 0 ||
        bound === null ||
        typeof bound !== 'object' ||
        bound.system !== externalSubject.system ||
        bound.subjectId !== externalSubject.subjectId
      ) {
        return { status: 'inconsistent' };
      }
      if (record.status === 'revoked') return { status: 'revoked', actorId: record.entityId };
      if (record.status !== 'active') return { status: 'inconsistent' };
      return { status: 'bound', actorId: record.entityId };
    },
  };
}
