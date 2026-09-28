import type { GovernedRightType, GovernedRightsScope } from '@aoc-enterprise/governed-authorization';

import type { ExecutionRiskLevel } from '../../features/action-enforcement/domain/execution-intent.js';
import type { DeclaredGovernedParameter, GovernedActionSemantics } from '../../features/governed-parameter-runtime/index.js';
import type { SideEffectType } from '../../features/action-enforcement/domain/side-effect.js';

/**
 * Identifies the requesting actor without embedding a mutable user/agent
 * record. `principalId` mirrors `EnforcementRequest.principalActorId` --
 * present only when the actor is acting on behalf of another actor (e.g. an
 * agent acting for a human).
 */
export interface ActorReference {
  readonly id: string;
  readonly principalId?: string;
  readonly trustDomainId: string;
  readonly type?: string;
}

/**
 * Describes the action being evaluated. Fields beyond `type`/`resourceScope`
 * mirror what the wrapped engine actually consumes: `capability`/`riskLevel`/
 * `sideEffectType` feed `ExecutionIntent`; `domain`/`jurisdiction`/`country`/
 * `industry`/`customerId`/`amount`/`currency`/`counterpartyId`/`dataDomains`/
 * `evidenceIds` feed the optional Domain Policy Pack Runtime preflight
 * integration (`EnforcementPolicyEvaluationInput`) and are ignored entirely
 * when no policy pack integration is configured on the kernel.
 */
export interface ActionDescriptor {
  readonly type: string;
  readonly domain?: string;
  readonly jurisdiction?: string;
  readonly country?: string;
  readonly industry?: string;
  readonly customerId?: string;
  readonly capability?: string;
  readonly resourceScope: string;
  readonly riskLevel?: ExecutionRiskLevel;
  readonly sideEffectType?: SideEffectType;
  /**
   * The monetary quantity this action moves, as **canonical decimal text**
   * (`src/features/monetary-runtime`): `"7500"`, `"0.3"`, never `7500` or
   * `"7500.00"`. Denominated in `currency`, an asset identifier.
   *
   * Text, not a number, since P9: a bounded grant's ceiling is derived from this
   * value, so an IEEE-754 double here would make the authority a rounding of
   * what was asked for. A value that is not canonical decimal text states no
   * amount the grant layer can bound, and no ceiling is derived from it.
   */
  readonly amount?: string;
  readonly currency?: string;
  readonly counterpartyId?: string;
  readonly dataDomains?: readonly string[];
  readonly evidenceIds?: readonly string[];
  /**
   * Legacy, untyped, **never authority-material**: serialized terms some
   * library-only mandate services attach for the wrapped engine's recognition
   * metadata (`context.parameters`). It reaches no policy input, no grant
   * projection and no exercise request, and the governed-action path never
   * sets it (`kernel-legacy-parameters.test.ts`). The one canonical,
   * authority-relevant parameter model is `governedParameters` (CORE-03).
   *
   * @deprecated Non-authoritative compatibility field for library-only mandate
   * services. New code states typed, declared `governedParameters`.
   */
  readonly parameters?: Readonly<Record<string, unknown>>;

  /**
   * CORE-03 — what kind of action this is, over what kind of resource, and
   * which versioned Governance Profile classified it. Resolved by trusted
   * configuration, never stated by the caller; absent for an action no
   * profile governs, which is then evaluated exactly as before CORE-03.
   *
   * Carried into the policy input (`actionClass`, `resourceClass`,
   * `governanceProfile`), recorded with the committed decision, and bound into
   * every grant derived from it as the `governanceProfile` identity axis.
   */
  readonly semantics?: GovernedActionSemantics;

  /**
   * CORE-03 — the typed parameter values the action proposes, one per declared
   * dimension, each with the bound kind its trusted declaration gives it. In
   * canonical dimension order; present only together with `semantics`.
   *
   * A list of entries rather than a map keyed by dimension id, on purpose: an
   * id travels as a *value*, so it can never collide with a reserved or
   * redacted key name on its way into the Governance Store, and two requests
   * that differ in any parameter can never digest alike.
   *
   * Every one is authority-material: the decision is made on it, and a grant
   * derived from the decision bounds it (`exact` pins the evaluated value,
   * `maximum` admits it and anything below it).
   */
  readonly governedParameters?: readonly DeclaredGovernedParameter[];

  /**
   * The governed rights this action is trying to engage, declared as typed
   * vocabulary rather than as payload.
   *
   * Until this field existed, an action's target right travelled only inside
   * `parameters` as opaque serialized terms, and no authority check consulted
   * it -- so an actor scoped to `asset:work-a:usage-right` could move the
   * asset's *ownership interest* and the Authority Graph saw nothing wrong,
   * because nothing connected the scope string to the right being moved. That
   * measurement is recorded in
   * `src/enterprise/__tests__/transfer-authority-transition.test.ts`.
   *
   * Declaring it here is what lets `AocKernel` ask a governed-authority
   * question at all. Every right named must be covered independently: an
   * action engaging two rights needs authority over both, and partial coverage
   * is not coverage.
   *
   * Optional, and absent means exactly "this action engages no governed right"
   * -- never "engages all of them". An action that declares nothing is
   * evaluated by the capability/action/resource-scope chain alone, exactly as
   * every action was before this field existed.
   */
  readonly governedRights?: readonly GovernedRightType[];

  /**
   * How much of each declared right is engaged, when the action's own contract
   * expresses a quantity.
   *
   * Absent means the action does not fractionally express the right --
   * `LICENSE`'s optional `rightsScope` is the real case, where "display for 12
   * months" has no fraction. Absent is emphatically **not** 100%: it requires
   * the holder to hold some live authority over the right and asserts nothing
   * about how much. The four governed actions disagree about whether a scope
   * is required and whether it accumulates, and that disagreement is
   * load-bearing -- see `@aoc-enterprise/governed-authorization`'s
   * `GovernedRightsScope`.
   */
  readonly governedRightsScope?: GovernedRightsScope;

  /**
   * Whose governed authority this action draws on, when that is not the
   * requesting actor.
   *
   * These come apart constantly, and conflating them is the bug this field
   * exists to prevent: a portfolio manager submits a transfer of Party A's
   * economic interest, so the Authority Graph must authorize the *manager* to
   * act while the governed-authority layer must confirm that *Party A* holds
   * what is moving. Two independent questions, and neither substitutes for the
   * other -- a delegated administrator never acquires the holder's underlying
   * right by acting for it.
   *
   * Defaults to `actor.id` when absent, which is correct for an action whose
   * terms name no separate holder.
   */
  readonly governedAuthorityHolderRef?: string;
}

/** Mirrors `EnforcementTarget`. Optional -- when absent the wrapped engine defaults it from the action. */
export interface TargetReference {
  readonly id?: string;
  readonly type?: string;
  readonly name?: string;
  readonly adapterId?: string;
}

/**
 * Not a field the wrapped engine's request shape carries directly (there is
 * no `OrganizationReference` in `EnforcementRequest` -- `trustDomainId` is
 * the engine's tenant boundary). Kept as a documented, optional passthrough
 * into `context`/metadata for callers that track an organization id
 * alongside the trust domain.
 */
export interface OrganizationReference {
  readonly id: string;
  readonly name?: string;
}

export interface KernelEvaluationRequest {
  readonly requestId: string;
  readonly actor: ActorReference;
  readonly action: ActionDescriptor;
  readonly target?: TargetReference;
  readonly organization?: OrganizationReference;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
  readonly correlationId?: string;

  /** Caller-declared references to a prior approval/handshake proof, forwarded unchanged to the wrapped engine. */
  readonly approvalProofId?: string;
  readonly approvalRequestId?: string;
  readonly approvalDecisionId?: string;
  readonly visaId?: string;
  readonly ingressGrantId?: string;
  readonly handshakeProofId?: string;
  readonly idempotencyKey?: string;
  readonly expiresAt?: string;
}
