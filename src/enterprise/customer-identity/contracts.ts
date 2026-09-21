/**
 * The customer-plane identity contract.
 *
 * > Authentication answers who is calling.
 * > Subject binding answers which Frontera actor they represent.
 * > Recognition answers whether that actor exists in the authority world.
 * > Authorization answers what that actor may do.
 *
 * This module owns only the first two. A `BoundCustomerIdentity` is the one
 * fact every later governed execution may trust — *this authenticated
 * principal belongs to this organization and represents this Frontera actor*
 * — and nothing more. It is not an authorization, it carries no authority,
 * and it caches none: the Kernel still reads the current authority world when
 * an action is evaluated.
 *
 * See `docs/enterprise/AOC_CUSTOMER_PRINCIPAL_BINDING.md`.
 */

/**
 * The external application subject a principal represents.
 *
 * Structurally identical to `KernelAuthorityExternalSubject` on purpose: the
 * binding this module resolves is the Kernel Authority's own
 * `(organizationId, system, subjectId)` binding, never a second mapping.
 */
export interface CustomerExternalSubject {
  readonly system: string;
  readonly subjectId: string;
}

/**
 * An authenticated customer-plane caller.
 *
 * Deliberately has **no `system` flag** — `system: true` is Frontera's own
 * privileged operator context (`KernelAuthorityAccessContext`) and is not
 * representable here — and no actor id, no credential and no authority. The
 * `plane` discriminant is what keeps it from ever being mistaken for an
 * internal or operator context.
 */
export interface CustomerPrincipal {
  readonly plane: 'customer';
  /** Server-configured and non-secret. Never the credential, never derived from it. */
  readonly principalId: string;
  /** Taken from the credential's configuration, never from a request. Exactly one per principal. */
  readonly organizationId: string;
  readonly externalSubject: CustomerExternalSubject;
}

/** The minimum projection of the bound actor admission needs to hand on. Not the authority record. */
export interface BoundCustomerActor {
  readonly actorId: string;
}

/** A customer principal together with the one Frontera actor its external subject is bound to. Immutable. */
export interface BoundCustomerIdentity {
  readonly principal: CustomerPrincipal;
  readonly actor: BoundCustomerActor;
}

/**
 * Why a caller was not admitted, where the caller (or its configuration) is
 * the cause. `POST /api/governed-actions` answers these with 401/403
 * (`api/governed-action-contract.ts`).
 *
 * A vocabulary of its own, disjoint from every Kernel, obligation, issuance and
 * exercise reason code: admission happens **before** the Kernel, so none of
 * these is a `DENIED` or an `INDETERMINATE` — no decision exists yet, and no
 * Governance Record is written for them.
 */
export const CUSTOMER_IDENTITY_REFUSAL_REASONS = {
  /** No `Authorization` header was presented. */
  CUSTOMER_AUTH_REQUIRED: 'CUSTOMER_AUTH_REQUIRED',
  /** An `Authorization` header was presented but is not a bearer credential. */
  CUSTOMER_AUTH_MALFORMED: 'CUSTOMER_AUTH_MALFORMED',
  /** The bearer credential matches no configured key. */
  CUSTOMER_AUTH_INVALID: 'CUSTOMER_AUTH_INVALID',
  /** The credential is valid but not organization-scoped, so it can never be a customer principal. */
  CUSTOMER_AUTH_UNSCOPED: 'CUSTOMER_AUTH_UNSCOPED',
  /** The credential is valid and scoped but carries no customer identity metadata — a legacy key. */
  CUSTOMER_IDENTITY_NOT_CONFIGURED: 'CUSTOMER_IDENTITY_NOT_CONFIGURED',
  /** The credential's customer identity metadata is malformed. */
  CUSTOMER_IDENTITY_INVALID: 'CUSTOMER_IDENTITY_INVALID',
  /** The credential's organization is not the authority organization this instance serves. */
  CUSTOMER_ORGANIZATION_NOT_SERVED: 'CUSTOMER_ORGANIZATION_NOT_SERVED',
  /** No Frontera actor is bound to the principal's external subject in its organization. Nothing is created. */
  CUSTOMER_SUBJECT_UNBOUND: 'CUSTOMER_SUBJECT_UNBOUND',
  /** The bound actor has been revoked; a revoked binding admits no one. */
  CUSTOMER_SUBJECT_ACTOR_REVOKED: 'CUSTOMER_SUBJECT_ACTOR_REVOKED',
} as const;

export type CustomerIdentityRefusalReason = (typeof CUSTOMER_IDENTITY_REFUSAL_REASONS)[keyof typeof CUSTOMER_IDENTITY_REFUSAL_REASONS];

export const CUSTOMER_IDENTITY_REFUSAL_REASON_VALUES: readonly CustomerIdentityRefusalReason[] = Object.values(CUSTOMER_IDENTITY_REFUSAL_REASONS);

/**
 * Why a caller could not be admitted because Frontera could not answer, not
 * because the caller is wrong. `POST /api/governed-actions` answers these with
 * 503.
 * Kept apart from "unbound" so an outage is never reported as a missing
 * binding, and a missing binding is never retried as an outage.
 */
export const CUSTOMER_IDENTITY_UNAVAILABLE_REASONS = {
  /** The binding source threw or could not be read. */
  CUSTOMER_SUBJECT_LOOKUP_FAILED: 'CUSTOMER_SUBJECT_LOOKUP_FAILED',
  /** The binding source answered with a record that does not match the question asked — wrong kind, organization or subject. Treated as corruption. */
  CUSTOMER_SUBJECT_BINDING_INCONSISTENT: 'CUSTOMER_SUBJECT_BINDING_INCONSISTENT',
} as const;

export type CustomerIdentityUnavailableReason = (typeof CUSTOMER_IDENTITY_UNAVAILABLE_REASONS)[keyof typeof CUSTOMER_IDENTITY_UNAVAILABLE_REASONS];

export const CUSTOMER_IDENTITY_UNAVAILABLE_REASON_VALUES: readonly CustomerIdentityUnavailableReason[] = Object.values(CUSTOMER_IDENTITY_UNAVAILABLE_REASONS);

/**
 * The outcome of admitting one caller.
 *
 * No failure arm carries a free-form detail: a message is where a credential
 * or header would leak, and the reason code already says everything a caller
 * is entitled to know.
 */
export type CustomerIdentityAdmissionResult =
  | { readonly status: 'bound'; readonly identity: BoundCustomerIdentity }
  | { readonly status: 'refused'; readonly reason: CustomerIdentityRefusalReason }
  | { readonly status: 'unavailable'; readonly reason: CustomerIdentityUnavailableReason };

/**
 * Everything admission reads from a request: the `Authorization` header, and
 * nothing else.
 *
 * There is no actor, organization, system flag or external subject here, and
 * the implementation reads no other property of what it is handed. A caller
 * that attaches `actorId`, `organizationId` or `system: true` to this object
 * changes nothing — the identity is derived from configuration and the
 * authority store only.
 */
export interface CustomerIdentityAdmissionRequest {
  readonly authorizationHeader?: string;
}

/** The narrow capability Prompt 3's Governed Action Orchestrator consumes. Admits or refuses; never decides, provisions or executes. */
export interface CustomerIdentityAdmissionService {
  /** The one authority organization whose actors this instance can admit. */
  readonly organizationId: string;
  admit(request: CustomerIdentityAdmissionRequest): Promise<CustomerIdentityAdmissionResult>;
}
