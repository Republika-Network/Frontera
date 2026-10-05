import type { ExecutionFailureReason } from '../../features/execution-runtime/index.js';
import type { DeclaredGovernedParameter, GovernedActionSemantics } from '../../features/governed-parameter-runtime/index.js';
import type { RequestedGrantBounds } from '../../features/grant-runtime/index.js';
import type { FinancialActionClassifier, MonetaryAmount, MonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import type { KernelDecisionStatus } from '../../kernel/index.js';
import type { GovernanceProfileRegistry } from '../governance-profile/index.js';
import type { ReconsiderationIntent } from './reconsideration-lineage.js';

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

/**
 * A quantity the caller intends to move, as it arrives on the wire. Mapped onto
 * the Kernel's own `action.amount`/`action.currency`, and onto the exercise
 * amount the grant contains.
 *
 * `value` is **decimal text** — `"7500"`, `"10.50"` — by the time it reaches
 * this contract (P9). On the v1 HTTP wire a client may still write a JSON
 * number: the route reads that number's exact source characters and hands this
 * contract their canonical text (`api/exact-monetary-json.ts`). A JavaScript
 * `number` arriving here — from an in-process caller, where no source text
 * exists — is refused rather than re-spelled. `currency` is an asset identifier the deployment's
 * trusted asset registry recognizes; the asset's scale is the registry's, and
 * there is no field through which a caller could state one.
 */
export interface GovernedActionAmount {
  readonly value: string;
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
 * `amount` → `amount`/`currency` and the grant's `amount` ceiling;
 * `parameters` → typed `governedParameters` and the grant's parameter bounds
 * (CORE-03). There is no payload, no provider body and no metadata that could
 * reach an adapter without passing grant containment.
 *
 * ## Actor · Action · Resource (CORE-03)
 *
 * The actor is never here — it is the bound customer identity. `action` and
 * `resource` stay the concrete identifier and reference they always were; what
 * *kind* of action and resource they are (`actionClass`, `resourceClass`) and
 * which versioned Governance Profile governs the pair are resolved by trusted
 * configuration, never stated by the caller. A GovernedAction is not
 * inherently monetary: `amount` is one dimension, present only for an action
 * the host classifies as financial.
 */
export interface GovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly counterparty?: string;
  readonly amount?: GovernedActionAmount;
  /**
   * CORE-03 — typed values for the parameter dimensions the governing profile
   * declares, keyed by exact dimension id: a JSON number (a safe integer) for
   * an integer dimension, a string for a token, a boolean for a boolean. No
   * coercion: `"100"` is not 100. A key the profile does not declare — or a
   * differently-cased spelling of one it does — is refused, a required
   * dimension that is absent is refused, and an action no profile governs may
   * carry none at all.
   */
  readonly parameters?: Readonly<Record<string, unknown>>;
  /**
   * CORE-03 — a **hint that pins**, never a selector: the profile the caller
   * *expects* to govern this action, `{ id, version }`. The **effective**
   * profile is always the one the trusted resolver chooses from `action` ×
   * `resource`; it is what the decision records and the grant binds. An
   * expectation that disagrees with it (another id, an older or newer
   * version) is refused rather than honoured, and an absent expectation
   * changes nothing.
   */
  readonly expectedGovernanceProfile?: GovernedActionProfileExpectation;
  /**
   * Context the caller *asserts* — evidence references such as a passport or
   * capability-token id. It reaches the Kernel as `request.context`, where it
   * is verified rather than believed, and never reaches an adapter.
   */
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly correlationId?: string;
  /** Required. Scoped by the orchestrator to `(organization, principal)`, so two tenants or two principals can never collide on one key. */
  readonly idempotencyKey: string;
  /**
   * ANDREW-P0-09 — this request explicitly reconsiders an earlier withheld
   * governed action (`of`, its request id) because governance state changed
   * (`reason`). It is still a fresh request with its own `idempotencyKey`,
   * evaluated afresh; the original is never re-evaluated or rewritten. See
   * `governed-action/reconsideration.ts`.
   */
  readonly reconsideration?: ReconsiderationIntent;
}

/**
 * An intent after validation **and** host-trusted classification (P9).
 *
 * `actionClass` here is P9's financial / non-financial answer, and predates
 * CORE-03. It is **not** the domain-declared semantic class, which lives at
 * `semantics.actionClass` (CORE-03): kept under its P9 name so every P9 suite
 * passes unchanged.
 *
 * The class is not something the intent says; it is what the deployment's
 * financial action classifier says about `action`, and the two arms make the
 * only legal combinations the only representable ones:
 *
 * - `financial` — carries exactly one exact `MonetaryAmount`, strictly
 *   positive, canonical, in a recognized asset and within its trusted scale;
 * - `non-financial` — carries no amount at all.
 *
 * A caller cannot downgrade a financial action by omitting its amount (refused),
 * and cannot move money under a non-financial one by adding an amount (refused).
 */
export type ClassifiedGovernedActionIntent =
  | (GovernedActionIntentCommon & { readonly actionClass: 'financial'; readonly amount: MonetaryAmount })
  | (GovernedActionIntentCommon & { readonly actionClass: 'non-financial'; readonly amount?: undefined });

/** What a caller may state about the profile it expects. */
export interface GovernedActionProfileExpectation {
  readonly id: string;
  readonly version: number;
}

/**
 * The validated intent's fields other than money. `semantics` and `parameters`
 * are present together or not at all: exactly when a trusted Governance
 * Profile governs the action (CORE-03). `parameters` is the declared, typed,
 * canonically ordered list — never the caller's object.
 */
type GovernedActionIntentCommon = Omit<GovernedActionIntent, 'amount' | 'parameters' | 'expectedGovernanceProfile'> & {
  readonly semantics?: GovernedActionSemantics;
  readonly parameters?: readonly DeclaredGovernedParameter[];
};

/**
 * The trusted monetary configuration a governed-action boundary validates
 * against. Host composition only — built once, frozen, never extended by a
 * request.
 */
export interface GovernedActionMonetaryTrust {
  /** Which assets exist and each one's scale. An unrecognized unit is refused. */
  readonly assets: MonetaryAssetRegistry;
  /** Which actions are financial. An unlisted action is non-financial and may carry no amount. */
  readonly actionClassifier: FinancialActionClassifier;
}

/**
 * CORE-03 — the trusted semantic configuration an intent is classified
 * against: declared parameter dimensions, action classes, resource classes and
 * Governance Profiles. Host composition only. The monetary trust above is P9's
 * specialized financial classification and is unchanged beside it.
 */
export type GovernedActionSemanticTrust = GovernanceProfileRegistry;

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
  /**
   * This execution identity was already attempted and no initial outcome can be
   * established for it — none was recorded (a crash between the write-ahead
   * claim and the observation), or the record cannot be read or verified. The
   * adapter is not invoked again; the attempt needs reconciliation (P12).
   */
  GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED: 'GOVERNED_ACTION_EXECUTION_ALREADY_ATTEMPTED',
  /**
   * The adapter ran and **reported** that the provider was contacted but the
   * effect could not be confirmed either way — a connection lost after the
   * request was sent, a provider 5xx. Distinct from `…_ALREADY_ATTEMPTED`,
   * which means no outcome was ever recorded (a crash between claim and
   * outcome): here the adapter's own answer *is* on record, and that answer is
   * "unknown". The adapter is not invoked again; the effect needs
   * reconciliation, which nothing in Frontera performs.
   */
  GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED: 'GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED',
  /** The adapter ran, but its canonical durable outcome (the P11 initial observation) could not be recorded. Reported beside the outcome — never instead of it; a later replay reports the attempt as `…_ALREADY_ATTEMPTED`. */
  GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED: 'GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED',
  /**
   * CORE-05 — beside the Kernel's own codes on a `withheld: 'approval'`
   * result, when the decision's profile declares how it can be approved: the
   * approval request is recorded and open. A retry of the same request (same
   * idempotency key) resumes it once a durable, attributable approval of
   * exactly this decision completes.
   */
  GOVERNED_ACTION_APPROVAL_PENDING: 'GOVERNED_ACTION_APPROVAL_PENDING',
  /** CORE-05 — an eligible approver rejected exactly this decision. Final: no later approval resumes it. */
  GOVERNED_ACTION_APPROVAL_REJECTED: 'GOVERNED_ACTION_APPROVAL_REJECTED',
  /** CORE-05 — nobody completed the approval within the profile's request window. Final. */
  GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED: 'GOVERNED_ACTION_APPROVAL_REQUEST_EXPIRED',
  /** CORE-05 — the approval completed but lapsed (the profile's approval validity) before it was used. Final. */
  GOVERNED_ACTION_APPROVAL_EXPIRED: 'GOVERNED_ACTION_APPROVAL_EXPIRED',
  /** CORE-05 — an eligible actor revoked the approval request or its completed approval. Final: no grant is minted from it again, and an issued grant not yet exercised is not exercised. */
  GOVERNED_ACTION_APPROVAL_REVOKED: 'GOVERNED_ACTION_APPROVAL_REVOKED',
  /** CORE-05 — the request was opened under a Governance Profile or approval requirement trusted configuration no longer holds. Invalidated, never reinterpreted: a new governed request starts a new lifecycle. */
  GOVERNED_ACTION_APPROVAL_SUPERSEDED: 'GOVERNED_ACTION_APPROVAL_SUPERSEDED',
  /** CORE-05 — the durable approval store could not be read, verified or written. Never read optimistically: the decision stays withheld. */
  GOVERNED_ACTION_APPROVAL_UNAVAILABLE: 'GOVERNED_ACTION_APPROVAL_UNAVAILABLE',
  /** ANDREW-P0-09 — a reconsideration may not name itself. Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_SELF: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_SELF',
  /** ANDREW-P0-09 — the reconsidered request does not exist in this organization. Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_FOUND',
  /** ANDREW-P0-09 — the reconsidered request's committed record failed its integrity verification. Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_UNVERIFIABLE: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_UNVERIFIABLE',
  /** ANDREW-P0-09 — the reconsidered request belongs to another actor. Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_OTHER_ACTOR: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_OTHER_ACTOR',
  /** ANDREW-P0-09 — the named request is itself a reconsideration; only an original may be reconsidered (one root per lineage, so no chain or cycle). Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_ORIGINAL: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_ORIGINAL',
  /** ANDREW-P0-09 — the original was not withheld (it was allowed or awaits approval); there is nothing to reconsider. Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD: 'GOVERNED_ACTION_RECONSIDERATION_TARGET_NOT_WITHHELD',
  /** ANDREW-P0-09 — the reconsideration does not carry the original's business intent (who, action, resource, counterparty, amount, semantics). Nothing was evaluated. */
  GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH: 'GOVERNED_ACTION_RECONSIDERATION_INTENT_MISMATCH',
  /** ANDREW-P0-09 — the reconsideration's link to its original could not be durably recorded. No grant was issued. */
  GOVERNED_ACTION_RECONSIDERATION_LINK_FAILED: 'GOVERNED_ACTION_RECONSIDERATION_LINK_FAILED',
  /** ANDREW-P0-09 — this original business intent was already realized by another reconsideration. Withheld before any grant: one intent, at most one realization. */
  GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED: 'GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED',
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

/**
 * Which gate withheld an allowed-or-pending action. Each has its own owner and
 * vocabulary.
 *
 * `emergency-control` is the operational safety interlock, and it is its own
 * value rather than a flavour of `grant` or `exercise` because it is cleared by
 * a *person* rather than fixed by a change: the decision was sound, the grant
 * terms were sound, and an operator has stopped execution. Reporting it as a
 * grant refusal would send whoever is on call to debug an authorization that
 * was never wrong. Its reason codes are `EMERGENCY_CONTROL_*`, owned by
 * `src/features/emergency-control-runtime`.
 */
export type GovernedActionWithheldBy = 'approval' | 'obligations' | 'grant' | 'authority-binding' | 'grant-terms' | 'exercise' | 'emergency-control' | 'reconsideration';

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
