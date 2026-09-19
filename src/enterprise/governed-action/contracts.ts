import type { ExecutionFailureReason } from '../../features/execution-runtime/index.js';
import type { RequestedGrantBounds } from '../../features/grant-runtime/index.js';
import type { KernelDecisionStatus } from '../../kernel/index.js';

/**
 * The Governed Action contract: what a caller may *ask for*, and what it is
 * told happened.
 *
 * > This actor requested this action, the Kernel decided it, that decision was
 * > durably recorded, and only then could bounded authority be issued and
 * > exercised.
 *
 * See `docs/enterprise/AOC_GOVERNED_ACTION_ORCHESTRATOR.md`.
 */

/** A quantity the caller intends to move. Mapped onto the Kernel's own `action.amount`/`action.currency`, and onto the exercise amount the grant contains. */
export interface GovernedActionAmount {
  readonly value: number;
  readonly currency: string;
}

/**
 * What a caller intends. **Intent only.**
 *
 * There is no actor, organization, principal, system flag, external subject,
 * grant, grant expiry, authority binding, adapter, URL, credential, request id
 * or execution id here, and `validateGovernedActionIntent` refuses an object
 * that carries any property not declared below — so a caller who attaches
 * `actorId` or `system: true` is rejected rather than quietly ignored.
 *
 * Every field maps onto an existing canonical axis: `action` → the Kernel's
 * `action.type` and the grant's `action` bound; `resource` → `resourceScope`
 * and `resources`; `counterparty` → `counterpartyId` and `counterparty`;
 * `amount` → `amount`/`currency` and the grant's `amount` ceiling. There is no
 * payload, no provider body and no metadata that could reach an adapter
 * without passing grant containment.
 */
export interface GovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly counterparty?: string;
  readonly amount?: GovernedActionAmount;
  /**
   * Context the caller *asserts* — evidence references such as a passport or
   * capability-token id. It reaches the Kernel as `request.context`, where it
   * is verified rather than believed, and never reaches an adapter.
   */
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  /** Required. Scoped by the orchestrator to `(organization, principal)`, so two tenants or two principals can never collide on one key. */
  readonly idempotencyKey: string;
}

/**
 * What the trusted host decides about the grant a governed action may receive.
 * Never caller input.
 */
export interface GovernedActionGrantPolicyQuery {
  readonly organizationId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resource: string;
  readonly requestId: string;
  readonly decisionId: string;
  /** When the committed decision was made. Anchoring expiry here, rather than on `now`, makes a retry derive the same grant rather than a later one. */
  readonly evaluatedAt: string;
  readonly now: string;
}

export interface GovernedActionGrantTerms {
  /** Required, finite, after issuance. Contained by every ceiling at issuance regardless. */
  readonly grantExpiresAt: string;
  /** Narrowing only. An omitted axis inherits the persisted decision's bound. */
  readonly requestedBounds?: RequestedGrantBounds;
}

/**
 * The trusted host's grant policy. **Required, no default.**
 *
 * Returning `undefined` means "no expiry can be established for this action",
 * and the action is withheld — no grant is ever issued without a finite,
 * host-chosen horizon.
 */
export type GovernedActionGrantPolicy = (query: GovernedActionGrantPolicyQuery) => GovernedActionGrantTerms | undefined;

/**
 * Orchestration's own reason vocabulary. Disjoint from Kernel, `CUSTOMER_*`,
 * grant issuance, grant exercise and authority-binding codes, and used only
 * where no canonical owner exists: a failure that already has a vocabulary is
 * reported in that vocabulary.
 */
export const GOVERNED_ACTION_REASON_CODES = {
  /** The intent is malformed, carries an undeclared property, or asserts reserved identity/authority keys in its context. Nothing was evaluated. */
  GOVERNED_ACTION_INTENT_INVALID: 'GOVERNED_ACTION_INTENT_INVALID',
  /** The bound identity handed in is not a customer identity for the organization this orchestrator serves. Nothing was evaluated. */
  GOVERNED_ACTION_IDENTITY_INVALID: 'GOVERNED_ACTION_IDENTITY_INVALID',
  /** The idempotency key was already used by this principal for a different request. The original decision stands; nothing new was evaluated. */
  GOVERNED_ACTION_IDEMPOTENCY_CONFLICT: 'GOVERNED_ACTION_IDEMPOTENCY_CONFLICT',
  /** The Kernel threw rather than returning a decision. No decision exists, so none was persisted. */
  GOVERNED_ACTION_KERNEL_FAILED: 'GOVERNED_ACTION_KERNEL_FAILED',
  /** The Governance Store could not durably commit the decision. No grant, no exercise. */
  GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED: 'GOVERNED_ACTION_DECISION_PERSISTENCE_FAILED',
  /** The committed decision could not be re-read, or did not verify. No grant, no exercise. */
  GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE: 'GOVERNED_ACTION_PERSISTED_DECISION_UNVERIFIABLE',
  /** The committed decision disagrees with the request or with the decision the Kernel returned. The persisted record never loses to a transient one, and neither is issued from. */
  GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH: 'GOVERNED_ACTION_PERSISTED_DECISION_MISMATCH',
  /** The execution composition is mis-wired (a Kernel without grants, or two grant declarations). */
  GOVERNED_ACTION_COMPOSITION_INVALID: 'GOVERNED_ACTION_COMPOSITION_INVALID',
  /** The trusted grant policy established no expiry for this action, so no grant may be issued. */
  GOVERNED_ACTION_GRANT_TERMS_UNAVAILABLE: 'GOVERNED_ACTION_GRANT_TERMS_UNAVAILABLE',
  /** The grant store failed while issuing. Nothing reached the adapter. */
  GOVERNED_ACTION_GRANT_ISSUANCE_FAILED: 'GOVERNED_ACTION_GRANT_ISSUANCE_FAILED',
  /** The authorization reference for the issued grant could not be appended. Nothing reached the adapter. */
  GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED: 'GOVERNED_ACTION_AUTHORIZATION_EVIDENCE_FAILED',
  /** The write-ahead execution record could not be appended. The adapter was not invoked. */
  GOVERNED_ACTION_EXECUTION_CLAIM_FAILED: 'GOVERNED_ACTION_EXECUTION_CLAIM_FAILED',
  /** This execution identity was already attempted and its outcome is not on record. The adapter is not invoked again; the attempt needs reconciliation. */
  GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED: 'GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED',
  /** The adapter ran, but the outcome record could not be appended. Reported beside the outcome — never instead of it. */
  GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED: 'GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED',
} as const;

export type GovernedActionReasonCode = (typeof GOVERNED_ACTION_REASON_CODES)[keyof typeof GOVERNED_ACTION_REASON_CODES];

export const GOVERNED_ACTION_REASON_CODE_VALUES: readonly GovernedActionReasonCode[] = Object.values(GOVERNED_ACTION_REASON_CODES);

/** The committed decision a result stands on. Present whenever a Governance Record exists for the request. */
export interface GovernedActionDecisionRef {
  readonly decisionId: string;
  readonly evaluationId: string;
  readonly status: KernelDecisionStatus;
  /** The Kernel's own reason codes, verbatim from the committed record. */
  readonly reasonCodes: readonly string[];
}

interface GovernedActionResultBase {
  /** Server-derived. Absent only when the intent was too malformed to scope. */
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly decision?: GovernedActionDecisionRef;
  /** Server-derived from the committed decision. Present once an execution identity exists. */
  readonly executionId?: string;
  /**
   * The codes that explain this result, in the vocabulary of the layer that
   * owns them: Kernel codes for a decision, grant issuance or authority-binding
   * codes for a withheld grant, exercise codes for a withheld exercise, and
   * `GOVERNED_ACTION_*` only where orchestration itself is the owner.
   */
  readonly reasonCodes: readonly string[];
}

/** Which gate withheld an allowed-or-pending action. Each has its own owner and vocabulary. */
export type GovernedActionWithheldBy = 'approval' | 'obligations' | 'grant' | 'authority-binding' | 'grant-terms' | 'exercise';

/**
 * What a governed action produced.
 *
 * **Never carries a bounded grant**, its scope, its digest, a credential, a
 * store handle, an adapter or a system context. The grant exists — it is what
 * the exercise gate reads — but it is an internal authority artifact, and the
 * evidence trail references it by id in the Governance Record rather than here.
 */
export type GovernedActionResult =
  | (GovernedActionResultBase & {
      readonly status: 'executed';
      readonly providerRef?: string;
      /** `true` when this call found the outcome already on record for this execution identity and did not invoke the adapter. */
      readonly replayed: boolean;
      readonly outcomeRecorded: boolean;
    })
  | (GovernedActionResultBase & { readonly status: 'denied' })
  | (GovernedActionResultBase & { readonly status: 'indeterminate' })
  | (GovernedActionResultBase & { readonly status: 'withheld'; readonly withheldBy: GovernedActionWithheldBy })
  | (GovernedActionResultBase & {
      readonly status: 'execution_failed';
      readonly failure: ExecutionFailureReason;
      readonly replayed: boolean;
      readonly outcomeRecorded: boolean;
    })
  | (GovernedActionResultBase & { readonly status: 'execution_unconfirmed' })
  | (GovernedActionResultBase & { readonly status: 'rejected' })
  | (GovernedActionResultBase & { readonly status: 'system_error' });

export type GovernedActionResultStatus = GovernedActionResult['status'];
