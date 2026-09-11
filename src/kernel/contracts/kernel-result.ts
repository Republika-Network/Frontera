import type { KernelTrace } from './kernel-trace.js';

/**
 * Coarse, stable status bucket. The wrapped engine's `EnforcementDecisionType`
 * has 11 variants; this collapses them into 4 per the kernel's public
 * contract. The mapping (documented in `reason-codes/reason-codes.ts`) is:
 *   - allowed            <- execute_allowed, dry_run_allowed
 *   - denied             <- execution_blocked, adapter_denied, emergency_denied, expired,
 *                           invalid_request, duplicate_suppressed (already executed once under
 *                           this idempotency key; the engine deliberately will not run it again --
 *                           `allowedToExecute` is false for this decision type in the wrapped engine
 *                           too, see `EXECUTABLE_DECISION_TYPES`. `ACTION_DUPLICATE_SUPPRESSED` in
 *                           `reasonCodes` distinguishes it from a genuine governance denial.)
 *   - approval_required  <- approval_required, evidence_required, external_handshake_required
 *   - indeterminate      <- a kernel-boundary failure (e.g. an unhandled throw from the
 *                           recognition provider) that the wrapped engine itself does not
 *                           catch -- see AOC_KERNEL_INVARIANTS_V1.md
 * `reasonCodes` (not `status`) is the fine-grained, stable machine-readable signal --
 * `approval_required` status does not by itself distinguish "needs human approval" from
 * "needs more evidence"; the reason codes do.
 */
export type KernelDecisionStatus = 'allowed' | 'denied' | 'approval_required' | 'indeterminate';

/** Reflects only what `RecognitionVerificationResult` exposes structurally -- not recognition-runtime's internal per-policy chain, which is not visible across that structural boundary. */
export interface RecognitionEvaluation {
  readonly performed: boolean;
  readonly decisionId?: string;
  readonly decisionType?: string;
  readonly recognized?: boolean;
  readonly reasonCode?: string;
  readonly reason?: string;
}

/**
 * One governed right's coverage verdict from the configured
 * `GovernedAuthorityProvider`, reported per right so a two-right action's
 * denial names the right that actually failed rather than the action as a
 * whole.
 *
 * `holderRef` is reported alongside because it is frequently *not* the
 * requesting actor, and a reviewer reading a denial needs to see whose
 * authority was checked.
 */
export interface GovernedRightEvaluation {
  readonly governedRight: string;
  readonly holderRef: string;
  readonly outcome: string;
  /**
   * Whether recognized governed authority was actually *verified* to cover
   * this right — not whether the request was let through.
   *
   * A right on an unenrolled resource is `covered: false` with the enclosing
   * `enforced: false`: the request proceeds under the legacy compatibility
   * policy, and reporting that as coverage would assert a check that never
   * happened.
   */
  readonly covered: boolean;
}

/**
 * The governed-authority half of an authority evaluation: whether the typed,
 * right-scoped check ran, and what it found for each right the action
 * declared.
 *
 * `performed: false` with no results means the action declared no governed
 * right, or no provider is configured -- both of which are ordinary and
 * neither of which is a finding. `enforced` distinguishes "ran and the
 * resource is enrolled" from "ran and this deployment holds no authority state
 * for the resource at all", which is the distinction the legacy compatibility
 * policy turns on.
 */
export interface GovernedAuthorityEvaluation {
  readonly performed: boolean;
  readonly enforced: boolean;
  readonly rights: readonly GovernedRightEvaluation[];
}

/**
 * The holder-bound representation half of an authority evaluation: whether the
 * requester was proven authorized to exercise the named holder's governed
 * authority.
 *
 * `performed: false` means the question was not asked -- no provider is
 * configured, the action declares no governed right, or the resource is not
 * enrolled in right-scoped authority. `required: false` with
 * `performed: true` is the direct-holder case: the requester *is* the holder,
 * so nothing needed representing, and reporting that as a passed check would
 * assert a proof that was never sought.
 */
export interface GovernedRepresentationEvaluation {
  readonly performed: boolean;
  /** Whether the requester and the holder differ, which is the only case in which a representation is needed at all. */
  readonly required: boolean;
  /** The party whose authority the request draws on. */
  readonly holderRef: string;
  /** The party that made the request. */
  readonly representativeRef: string;
  readonly rights: readonly GovernedRightRepresentationEvaluation[];
}

/** One governed right's representation verdict, reported per right for the same reason authority coverage is: a two-right action's denial must name the right that actually failed. */
export interface GovernedRightRepresentationEvaluation {
  readonly governedRight: string;
  /** The `GovernedRepresentationCoverage` outcome, verbatim. Where the three public reason codes are compact, this is where the specific cause survives. */
  readonly outcome: string;
  readonly covered: boolean;
  /** The representation relied on, when one was. Absent for a denial with no candidate binding, and for the direct-holder case. */
  readonly representativeAuthorityId?: string;
  /** The binding and its ancestors, root last, when a redelegated representation authorized the request. Present only on a pass, and only when a chain exists. */
  readonly chain?: readonly string[];
}

/** Derived from the `authorityDecisionId`/`authorityProofId` references a recognition result carries -- Authority Graph's own decision object is not visible across the structural `EnforcementRecognitionIntegration` boundary, so no `valid` field is fabricated here -- plus, when configured, the governed-authority verdict `AocKernel` obtained directly from its own provider port. */
export interface AuthorityEvaluation {
  readonly performed: boolean;
  readonly decisionId?: string;
  readonly proofId?: string;
  /** Present only when a `GovernedAuthorityProvider` is configured. Absent means the kernel asked no governed-right question, not that one passed. */
  readonly governedAuthority?: GovernedAuthorityEvaluation;
  /** Present only when a `GovernedRepresentationProvider` is configured and the action declares a governed right. Absent means the kernel asked no representation question, not that one passed. */
  readonly representation?: GovernedRepresentationEvaluation;
}

/** One-to-one with `EnforcementPolicyResult` from the wrapped engine's own (action-enforcement) policy chain. */
export interface PolicyEvaluation {
  readonly policyId: string;
  readonly passed: boolean;
  readonly reasonCode: string;
  readonly reason: string;
  readonly severity: 'info' | 'warning' | 'error' | 'critical';
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ApprovalStatus = 'not_applicable' | 'pending' | 'granted';

/** `status: 'rejected'` was considered and omitted: the structural `RecognitionVerificationResult` does not reliably distinguish an approval rejection from other hard-block reasons -- see AOC_KERNEL_INVARIANTS_V1.md. */
export interface ApprovalEvaluation {
  readonly performed: boolean;
  readonly status: ApprovalStatus;
  readonly requestId?: string;
  readonly decisionId?: string;
  readonly proofId?: string;
}

/**
 * One resolved context fact, reduced to its provenance.
 *
 * **There is no `value` field, and its absence is deliberate.**
 * `ADR-CONTEXT-PROVENANCE-AND-TRUST.md` §8 sets the default disclosure for a
 * fact's value to hidden: "an auditor needs to know the decision turned on an
 * authoritative ERP read of `vendor.status` at 14:02, not necessarily what the
 * status was." This result travels into the Governance Record and is
 * canonicalized and digested there, so withholding the value at the type level
 * is what keeps business data out of the evidence graph without needing a
 * disclosure policy to remember to strip it. Values reach *policy*, which needs
 * them to decide; they do not reach the record.
 */
export interface ContextFactEvaluation {
  readonly key: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  /** The declared class, including `derived`. */
  readonly trustClass: string;
  /** The class the fact was actually compared at — for a derived fact, the minimum of its operands'. */
  readonly effectiveTrustClass: string;
  readonly resolution: string;
  readonly observedAt: string;
  readonly staleAt?: string;
  /** Present only for a conflicted fact: the other sources that answered this key differently. */
  readonly conflictingSourceIds?: readonly string[];
}

/**
 * What the context layer resolved for this evaluation.
 *
 * Present only when a `ContextProvider` is configured *and* the deployment
 * declared at least one requirement. Absent means the kernel resolved no
 * context — never that context was resolved and found empty, which is what
 * `resolved: false` says.
 */
export interface ContextEvaluation {
  readonly performed: boolean;
  /** `false` means the resolver was consulted and could not answer. Never "there are none". */
  readonly resolved: boolean;
  readonly declaredKeys: readonly string[];
  readonly facts: readonly ContextFactEvaluation[];
  readonly unresolved: readonly string[];
  readonly stale: readonly string[];
  readonly conflicted: readonly string[];
  readonly assertedFactPolicy: string;
  /**
   * Under the `report` migration posture, the declared keys that were satisfied
   * by a fact the requester supplied.
   *
   * This is the list ADR §7 exists to produce: what would stop matching under
   * `require-declaration`, surfaced before anything stops matching. Absent under
   * every other posture.
   */
  readonly assertedFactReads?: readonly string[];
  /** Declared-required keys whose requirement was not met, with the read status that explains why. Empty on a pass. */
  readonly unsatisfiedRequirements?: readonly ContextRequirementEvaluation[];
}

/** One declared-required key that was not satisfied, and the facts-level reason. */
export interface ContextRequirementEvaluation {
  readonly key: string;
  readonly status: string;
  readonly minimumTrustClass: string;
}

/** One entry per `evidence_required`-policy result the wrapped engine's own chain recorded. */
export interface EvidenceEvaluation {
  readonly policyId: string;
  readonly passed: boolean;
  readonly reasonCode: string;
  readonly reason: string;
}

export interface KernelEvaluationResult {
  readonly requestId: string;
  readonly decisionId: string;
  readonly status: KernelDecisionStatus;
  readonly reasonCodes: readonly string[];
  readonly summary: string;
  readonly recognition: RecognitionEvaluation;
  readonly authority: AuthorityEvaluation;
  readonly policies: readonly PolicyEvaluation[];
  readonly approval: ApprovalEvaluation;
  readonly evidence: readonly EvidenceEvaluation[];
  /** Present only when a `ContextProvider` is configured and the deployment declared at least one context requirement. Absent means no context was resolved, not that none was found. */
  readonly context?: ContextEvaluation;
  readonly trace: KernelTrace;
  readonly evaluatedAt: string;
  readonly kernelVersion: string;
  readonly correlationId?: string;
}
