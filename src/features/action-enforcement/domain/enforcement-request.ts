import type { EnforcementTarget } from './enforcement-target.js';
import type { ExecutionIntent } from './execution-intent.js';
import type { SideEffectDescriptor } from './side-effect.js';

export type EnforcementMode = 'preflight' | 'execute' | 'dry_run';

/**
 * Optional, caller-declared fields consulted by the (optional) Domain
 * Policy Pack Runtime preflight integration. None of these fields mean
 * anything to Recognition Runtime, Authority Graph, Approval Runtime or
 * External Agent Handshake -- they exist purely so a policy pack can be
 * scope-matched (domain/jurisdiction/country/industry/customerId) and can
 * evaluate domain-specific conditions (amount/currency/counterpartyId/
 * dataDomains/evidenceIds) that Recognition Runtime has no reason to know.
 */
export interface EnforcementPolicyEvaluationInput {
  readonly domain?: string;
  readonly jurisdiction?: string;
  readonly country?: string;
  readonly industry?: string;
  readonly customerId?: string;

  /** Canonical decimal text (`src/features/monetary-runtime`), never a number. Ordered predicates compare it exactly. */
  readonly amount?: string;
  readonly currency?: string;
  readonly counterpartyId?: string;
  readonly dataDomains?: readonly string[];

  readonly evidenceIds?: readonly string[];

  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type EnforcementRequestStatus =
  | 'submitted'
  | 'preflight_passed'
  | 'preflight_failed'
  | 'blocked'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'cancelled';

export interface EnforcementRequest {
  readonly id: string;

  readonly mode: EnforcementMode;
  readonly status: EnforcementRequestStatus;

  readonly trustDomainId: string;

  readonly actorId: string;
  readonly principalActorId?: string;

  readonly action: string;
  readonly capability?: string;
  readonly resourceScope: string;

  readonly actionRequestId?: string;

  readonly recognitionDecisionId?: string;
  readonly authorityDecisionId?: string;
  readonly authorityProofId?: string;
  readonly approvalRequestId?: string;
  readonly approvalDecisionId?: string;
  readonly approvalProofId?: string;
  readonly handshakeDecisionId?: string;
  readonly handshakeProofId?: string;
  readonly visaId?: string;
  readonly ingressGrantId?: string;

  readonly target: EnforcementTarget;
  readonly intent: ExecutionIntent;

  readonly idempotencyKey?: string;

  readonly sideEffects: readonly SideEffectDescriptor[];

  readonly submittedAt: string;
  readonly expiresAt?: string;

  /** Caller-declared context for the optional Domain Policy Pack Runtime preflight integration. Absent when no policy pack context applies. */
  readonly policyEvaluationInput?: EnforcementPolicyEvaluationInput;

  readonly metadata?: Readonly<Record<string, unknown>>;
}
