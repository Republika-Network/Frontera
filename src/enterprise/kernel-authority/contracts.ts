/**
 * Kernel Authority Store contracts: the durable, operator-provisioned
 * recognition/authority world `AocKernel.evaluate()` decides against.
 *
 * What this is: the source of truth for *who is recognized* and *what
 * authority stands behind them* — actors, trust domains, passports,
 * capability tokens, root issuers, authority grants and delegation grants,
 * each an operator-provisioned fact that survives process restart.
 *
 * What this is **not**: a decision engine. Nothing in this module evaluates
 * a request, interprets a policy, or produces an allow/deny. It stores facts;
 * `AocKernel` decides. That separation is the load-bearing invariant of this
 * layer — see `docs/enterprise/AOC_DURABLE_KERNEL_AUTHORITY.md` and
 * `docs/architecture/ADR-DURABLE-KERNEL-AUTHORITY.md`.
 *
 * It is also distinct from the **Governed Authority Store**
 * (`../authority-governance/`), which answers a different question entirely:
 * "does this holder control this much of this *right* of this resource?"
 * (economic interest, ownership interest — fractional positions). The two
 * authority models are not the same model under two names and are
 * deliberately not merged; see the ADR's "Two authority models" section.
 *
 * And it is distinct from the **Governance Store**
 * (`../governance-store/`), which is the durable record of evaluations that
 * already happened. Evaluation history is not an authority source: a store
 * of past decisions cannot answer "may this actor act now?" without
 * re-deciding, which is precisely what it must not do.
 */

import type { AuthorityActorType, AuthorityConstraint } from '../../features/authority-graph/domain/authority-grant.js';
import type { ActorType } from '../../features/recognition-runtime/domain/actor.js';
import type { ApprovalRequirement, EvidenceRequirement, RiskLevel } from '../../features/recognition-runtime/domain/capability-token.js';
import type { PassportType } from '../../features/recognition-runtime/domain/passport.js';

/** Runtime version of the Kernel Authority Runtime — reported in the release manifest alongside its sibling runtimes. */
export const AOC_KERNEL_AUTHORITY_RUNTIME_VERSION = '1.0.0';

/** On-disk schema identity. A store written under a different identifier is refused at open, never migrated in place or silently adopted. */
export const KERNEL_AUTHORITY_SCHEMA_VERSION = 'aoc.kernel-authority.schema.v1';

export const KERNEL_AUTHORITY_CONTRACT_IDS = {
  store: 'aoc.kernel-authority.store.v1',
  event: 'aoc.kernel-authority.event.v1',
  record: 'aoc.kernel-authority.record.v1',
  provisioning: 'aoc.kernel-authority.provisioning.v1',
} as const;

/**
 * The seven state families a real `AocKernel.evaluate()` ALLOW is composed
 * of, and nothing else. Each was proven necessary by executing the actual
 * engine, not inferred from a type: removing any one of them turns the
 * canonical positive control into a denial. See the ADR's state inventory.
 */
export const KERNEL_AUTHORITY_ENTITY_KINDS = [
  'actor',
  'trust-domain',
  'passport',
  'capability-token',
  'root-issuer',
  'authority-grant',
  'delegation-grant',
] as const;

export type KernelAuthorityEntityKind = (typeof KERNEL_AUTHORITY_ENTITY_KINDS)[number];

export type KernelAuthorityEventType = 'KernelAuthorityEntityProvisioned' | 'KernelAuthorityEntityRevoked';

/** `active` is the only status a hydrated world admits as live authority; `revoked` is terminal and is never re-provisionable. */
export type KernelAuthorityEntityStatus = 'active' | 'revoked';

/**
 * Tenant/role scope for every Kernel Authority Store call. Identical in shape
 * to `AuthorityGovernanceContext`, `PassportAccessContext` and
 * `GovernanceStoreAccessContext` on purpose — a caller that already holds one
 * of those holds this one, and the tenancy rule a reviewer learned once
 * applies here unchanged.
 *
 * `system: true` is the privileged **operator** context. It is the only
 * context that may write (provision or revoke), and it is deliberately never
 * reachable from an evaluation request, a governed action, or an HTTP route.
 * Evaluation reads with an ordinary organization-scoped context and can only
 * ever read.
 */
export interface KernelAuthorityAccessContext {
  readonly system: boolean;
  readonly organizationId?: string;
  /** The operator identity credited in the durable audit trail for a write. Required for writes; ignored for reads. */
  readonly actorId?: string;
}

/**
 * An explicit, first-class binding from an external application's principal
 * to a Frontera actor.
 *
 * Deliberately typed and indexed rather than smuggled through an actor's
 * free-form `metadata` bag: an undocumented metadata key is not a security
 * boundary, and a downstream application must never have to maintain a second
 * authority mapping table of its own. Frontera owns this mapping.
 *
 * `system` names the external identity provider or application whose subject
 * id this is (`'pmfreak'`, `'okta'`, `'auth0'` …) — it is an opaque label to
 * Frontera and carries no semantics beyond namespacing. `(organizationId,
 * system, subjectId)` is unique: the same external subject id issued by two
 * different systems, or by the same system in two organizations, resolves to
 * two different actors and never leaks authority between them.
 */
export interface KernelAuthorityExternalSubject {
  readonly system: string;
  readonly subjectId: string;
}

// ---------------------------------------------------------------------------
// Provisioning payloads. Each mirrors the *engine's own* registration input
// for that entity, so a provisioned record replays into the unmodified
// Recognition Runtime / Authority Graph exactly as the engine's own fixtures
// register it — never through a Frontera-specific shortcut.
// ---------------------------------------------------------------------------

/**
 * Re-exported from the decision engines' own domains rather than restated
 * here. A second, hand-written copy of these unions would be a duplicate
 * semantic contract that could drift from the engine that actually enforces
 * them -- and a provisioning payload whose vocabulary has drifted from the
 * engine's is a payload that cannot be replayed.
 */
export type KernelAuthorityEvidenceRequirement = EvidenceRequirement;
export type KernelAuthorityApprovalRequirement = ApprovalRequirement;
export type KernelAuthorityActorType = ActorType;
export type KernelAuthorityDelegateActorType = AuthorityActorType;
export type KernelAuthorityPassportType = PassportType;
export type KernelAuthorityRiskLevel = RiskLevel;

export interface ProvisionActorInput {
  readonly actorId: string;
  readonly type: KernelAuthorityActorType;
  readonly displayName: string;
  readonly issuerId?: string;
  readonly trustDomainId?: string;
  readonly jurisdiction?: string;
  /** Explicit external-principal binding. Unique per `(organization, system, subjectId)`. */
  readonly externalSubject?: KernelAuthorityExternalSubject;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ProvisionTrustDomainInput {
  readonly trustDomainId: string;
  readonly name: string;
  readonly issuerActorId: string;
  readonly acceptedIssuerIds: readonly string[];
  readonly acceptedActorTypes: readonly KernelAuthorityActorType[];
  readonly jurisdiction?: string;
  readonly policyPackIds?: readonly string[];
}

export interface ProvisionPassportInput {
  readonly passportId: string;
  readonly type: KernelAuthorityPassportType;
  readonly subjectActorId: string;
  readonly issuerActorId: string;
  readonly trustDomainId: string;
  readonly expiresAt?: string;
}

export interface ProvisionCapabilityTokenInput {
  readonly capabilityTokenId: string;
  readonly subjectActorId: string;
  readonly principalActorId: string;
  readonly issuerActorId: string;
  readonly trustDomainId: string;
  readonly capability: string;
  readonly actions: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly riskLevel: KernelAuthorityRiskLevel;
  /**
   * Evidence the engine requires before an action may proceed.
   *
   * Part of the durable contract rather than left out of it: the recognition
   * policy chain enforces these, so a token that omitted them on the way into
   * the store would come back out of it *less* restricted than the operator
   * provisioned -- authority widening by round-trip.
   */
  readonly evidenceRequirements?: readonly KernelAuthorityEvidenceRequirement[];
  /** Human approval the engine requires for the named actions. Persisted for the same reason as `evidenceRequirements`. */
  readonly approvalRequirement?: KernelAuthorityApprovalRequirement;
  readonly prohibitedActions?: readonly string[];
  readonly delegable?: boolean;
  readonly maxDelegationDepth?: number;
  readonly jurisdiction?: string;
  readonly expiresAt?: string;
}

export interface ProvisionRootIssuerInput {
  readonly trustDomainId: string;
  readonly actorId: string;
}

/**
 * P10 — the monetary authority constraints the durable store carries: a
 * per-execution ceiling (`max_amount`) and aggregate spending limits
 * (`spending_limit`), in the Authority Graph's own vocabulary rather than a
 * restated copy of it.
 *
 * Only these two kinds are accepted on the durable provisioning surface. The
 * Authority Graph declares others (`time_window`, `data_boundary`, …) that no
 * evaluator enforces, and persisting a constraint that nothing enforces would
 * record authority that *reads* narrower than it behaves. Values are canonical
 * decimal text; an asset's scale is never stated here — it is the trusted
 * `MonetaryAssetRegistry`'s alone. See `monetary-constraints.ts` and
 * `docs/architecture/ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md`.
 */
export type KernelAuthorityMonetaryConstraint = Extract<AuthorityConstraint, { readonly type: 'max_amount' | 'spending_limit' }>;

export interface ProvisionAuthorityGrantInput {
  readonly authorityGrantId: string;
  readonly issuerActorId: string;
  readonly subjectActorId: string;
  readonly trustDomainId: string;
  readonly capability: string;
  readonly actions: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly roleId?: string;
  readonly canDelegate?: boolean;
  readonly allowedDelegateActorTypes?: readonly KernelAuthorityDelegateActorType[];
  readonly maxDelegationDepth?: number;
  readonly nonDelegableActions?: readonly string[];
  readonly expiresAt?: string;
  readonly parentGrantId?: string;
  /**
   * P10 — monetary authority. Persisted in the event payload (so it is covered
   * by the event digest and chain), replayed into the Authority Graph on
   * hydration, and validated on append and again on hydration: a constraint
   * that disappeared on the round trip would widen authority.
   */
  readonly constraints?: readonly KernelAuthorityMonetaryConstraint[];
}

export interface ProvisionDelegationGrantInput {
  readonly delegationGrantId: string;
  readonly delegatorActorId: string;
  readonly delegateActorId: string;
  readonly delegateActorType: KernelAuthorityDelegateActorType;
  readonly trustDomainId: string;
  readonly sourceAuthorityGrantId: string;
  readonly capability: string;
  readonly actions: readonly string[];
  readonly resourceScopes: readonly string[];
  readonly principalActorId?: string;
  readonly canRedelegate?: boolean;
  readonly nonDelegableActions?: readonly string[];
  readonly expiresAt?: string;
  /** P10 — additional monetary constraints on the delegate. They can only add restrictions: every constraint on the source lineage still applies. */
  readonly constraints?: readonly KernelAuthorityMonetaryConstraint[];
}

/** Discriminated union of everything an operator can provision. The `kind` is the record's own kind — the store never infers it from payload shape. */
export type KernelAuthorityProvisionInput =
  | { readonly kind: 'actor'; readonly actor: ProvisionActorInput }
  | { readonly kind: 'trust-domain'; readonly trustDomain: ProvisionTrustDomainInput }
  | { readonly kind: 'passport'; readonly passport: ProvisionPassportInput }
  | { readonly kind: 'capability-token'; readonly capabilityToken: ProvisionCapabilityTokenInput }
  | { readonly kind: 'root-issuer'; readonly rootIssuer: ProvisionRootIssuerInput }
  | { readonly kind: 'authority-grant'; readonly authorityGrant: ProvisionAuthorityGrantInput }
  | { readonly kind: 'delegation-grant'; readonly delegationGrant: ProvisionDelegationGrantInput };

/**
 * Idempotency identity for one provisioning call (mission section 25).
 * Replaying the same key with the same payload returns the original record
 * and appends nothing; replaying it with a *different* payload is an explicit
 * conflict, never a second grant that widens authority.
 */
export interface KernelAuthorityIdempotency {
  readonly idempotencyKey: string;
}

export interface AppendKernelAuthorityEventInput {
  readonly organizationId: string;
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly eventType: KernelAuthorityEventType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt?: string;
  readonly idempotency?: KernelAuthorityIdempotency;
}

/**
 * One immutable entry in the durable authority audit trail. Answers, without
 * a second audit log: who provisioned it, what object changed, what authority
 * scope changed, when, which prior state it superseded
 * (`previousEventDigest`), and whether it was revoked.
 */
export interface KernelAuthorityEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  readonly eventType: KernelAuthorityEventType;
  readonly sequence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  /** The operator credited with this write — `KernelAuthorityAccessContext.actorId`. */
  readonly provisionedBy: string;
  readonly occurredAt: string;
  readonly persistedAt: string;
  readonly previousEventDigest?: string;
  readonly eventDigest: string;
  readonly schemaVersion: string;
  readonly runtimeVersion: string;
}

/**
 * The reconstructed current state of one provisioned entity. Always derived
 * from its event chain — the SQLite projection table is a cache, never a
 * second source of truth, and every column on it is re-derivable from
 * `kernel_authority_events`.
 */
export interface KernelAuthorityRecord {
  readonly organizationId: string;
  readonly entityKind: KernelAuthorityEntityKind;
  readonly entityId: string;
  /** The trust domain this record belongs to — the Kernel's own enforcement boundary. `undefined` only for a trust domain record itself, which *is* the boundary. */
  readonly trustDomainId?: string;
  readonly status: KernelAuthorityEntityStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly provisionedBy: string;
  readonly provisionedAt: string;
  readonly revokedBy?: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
  readonly latestSequence: number;
  readonly latestEventDigest: string;
}

export interface KernelAuthorityRecordQuery {
  readonly organizationId: string;
  readonly entityKind?: KernelAuthorityEntityKind;
  readonly trustDomainId?: string;
  /** When omitted, revoked records are included — a hydrated world needs them to deny with a truthful `*_REVOKED` reason rather than a generic "not found". */
  readonly status?: KernelAuthorityEntityStatus;
}

export interface KernelAuthorityStoreHealth {
  readonly providerKind: 'memory' | 'sqlite';
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  readonly readable: boolean;
  readonly writable: boolean;
  readonly schemaVersion: string;
  readonly migrationState: string;
  readonly recordCount: number;
}

export interface AppendKernelAuthorityEventResult {
  readonly event: KernelAuthorityEvent;
  readonly record: KernelAuthorityRecord;
  /** `true` when an idempotent replay returned the original record and appended nothing. */
  readonly replayed: boolean;
}
