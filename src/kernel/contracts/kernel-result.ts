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

/**
 * One step of an obligation's closed lifecycle, as it was taken.
 *
 * Carried so the state an obligation is in is *reconstructible* rather than
 * merely asserted: a reviewer reading a withheld execution sees `required →
 * pending → discharged`, who reported each step and when, instead of a single
 * word with no history behind it.
 */
export interface ObligationTransitionEvaluation {
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly reason: string;
}

/**
 * The discharge an obligation came to rest on, reduced to its provenance.
 *
 * **There is no payload field, and its absence is deliberate**, for the reason
 * `ContextFactEvaluation` has no `value`: this result travels into the
 * Governance Record and is canonicalized and digested there. What an auditor
 * needs is that the obligation was discharged by an independent approval source
 * at 14:02 under reference `AP-771` — not the approval note's contents.
 *
 * `verificationClass` is present because the configured source registry
 * supplied it, never because an observation reported one. An observation has no
 * field for it at all.
 */
export interface ObligationDischargeEvaluation {
  readonly sourceId: string;
  readonly sourceKind: string;
  /** `independent` or `self_reported`, decided entirely by operator configuration. */
  readonly verificationClass: string;
  readonly outcome: string;
  readonly observedAt: string;
  readonly subjectId?: string;
  /** The source's own opaque handle on the act — an approval id, a proof id. Never dereferenced by the Kernel. */
  readonly reference?: string;
}

/**
 * A verification attempt against a supplied discharge that did not succeed.
 *
 * ADR §2 gives a failed verification no lifecycle state of its own: the
 * obligation stays `discharged`, and this records why somebody could not
 * confirm it. `verified` is literally `false` — there is no shape here that can
 * report a successful verification, because a successful one is expressed by
 * the obligation's *state* being `verified`.
 */
export interface ObligationVerificationEvaluation {
  readonly verified: false;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly verificationClass: string;
  readonly observedAt: string;
  readonly subjectId?: string;
  readonly reference?: string;
}

/**
 * One declared obligation and where its lifecycle has reached.
 *
 * **There is no authorization field on this shape.** No allow, no deny, no
 * decision status, no policy effect. An obligation cannot carry an
 * authorization outcome, so nothing downstream can read one off it — which is
 * the core invariant of the obligation phase expressed as a type rather than as
 * a convention.
 */
export interface ObligationInstanceEvaluation {
  /** Deterministic, derived from the request correlation and the obligation type. Stable across evaluations of the same request. */
  readonly id: string;
  readonly obligationType: string;
  readonly blocking: boolean;
  /** One of the six closed lifecycle states: `required`, `pending`, `discharged`, `verified`, `waived`, `expired`. */
  readonly state: string;
  /** Whether the condition is met. A `discharged` obligation is *not* satisfied: self-reported is not confirmed. */
  readonly satisfied: boolean;
  readonly terminal: boolean;
  /** Whether this obligation is currently withholding exercise. Always `false` for a non-blocking one, whatever its state. */
  readonly withholdsExercise: boolean;
  readonly transitions: readonly ObligationTransitionEvaluation[];
  readonly discharge?: ObligationDischargeEvaluation;
  /** Present only when a verification attempt was made and did not succeed. Never changes `state` or `satisfied`. */
  readonly verification?: ObligationVerificationEvaluation;
  /** The deadline this obligation was declared with, when it was declared with one. Operator-configured; never requester-supplied. */
  readonly expiresAt?: string;
}

/** One discharge observation that arrived and did not count, with the reason it did not. Reported so "why is this still blocked" is answerable from the record. */
export interface DisregardedObligationObservationEvaluation {
  readonly obligationType: string;
  readonly sourceId: string;
  readonly outcome: string;
  readonly observedAt: string;
  readonly reason: string;
}

/**
 * What the obligation layer found for this evaluation — and, emphatically, not
 * what it decided.
 *
 * Present only when an `ObligationDischargeProvider` is configured *and* the
 * deployment declared at least one obligation. Absent means the Kernel asked no
 * obligation question — never that obligations were checked and found met.
 *
 * ## Why this is a separate field from `status`
 *
 * `KernelEvaluationResult.status` is the authorization decision and stays
 * exactly what the authority and policy layers concluded. This field says
 * whether the action that decision authorized may proceed right now. The two
 * are reported side by side and never folded, because
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 makes the distinction the
 * audit-critical one: "the evidence shows a decision that concluded X and a
 * grant that was withheld because obligation Y was not discharged."
 *
 * A result can therefore read `status: 'allowed'` with
 * `obligations.exerciseEligibility: 'blocked'`, and that combination is the
 * normal, intended one — not a contradiction to be tidied away.
 */
export interface ObligationEvaluation {
  readonly performed: boolean;
  /** `false` means the discharge provider was consulted and could not answer. Never "there are none" — every blocking obligation then stays unsatisfied. */
  readonly resolved: boolean;
  readonly declaredTypes: readonly string[];
  readonly obligations: readonly ObligationInstanceEvaluation[];
  /** `eligible` or `blocked`. Deliberately not an allow/deny vocabulary: this is not an authorization outcome and must never be readable as one. */
  readonly exerciseEligibility: string;
  /** The aggregate ADR §3 turns on: whether every *blocking* obligation this decision declared is satisfied. Non-blocking obligations never affect it. */
  readonly allBlockingObligationsSatisfied: boolean;
  /**
   * Why exercise is withheld, from `AOC_KERNEL_EXERCISE_REASON_CODES` — a
   * vocabulary structurally separate from the authorization reason codes in
   * `reasonCodes`. Absent when eligibility is `eligible`.
   */
  readonly exerciseReasonCodes?: readonly string[];
  readonly summary?: string;
  /** Observations that arrived and did not count. Absent when every observation was admissible. */
  readonly disregarded?: readonly DisregardedObligationObservationEvaluation[];
}

/**
 * One bound the source authorization stood under, reported so a caller can see
 * what a grant derived from this decision would be narrowed *from*.
 *
 * A projection of the closed bound algebra in
 * `src/features/grant-runtime/domain/grant-bound.ts`, widened to `string` on
 * `key`/`kind` for the reason every context and obligation field on this result
 * is widened: `KernelEvaluationResult` is a stable public contract, and pinning
 * a feature's closed union into it would make adding an axis a breaking change
 * to the frozen surface.
 */
export interface GrantBoundEvaluation {
  readonly key: string;
  readonly kind: string;
  /** Present for an `identity` bound. */
  readonly value?: string;
  /** Present for a `set` bound, sorted and de-duplicated. */
  readonly values?: readonly string[];
  /** Present for a `ceiling` bound. */
  readonly limit?: number;
  /** Present for a `ceiling` bound. */
  readonly unit?: string;
  /** Present for a `window` bound. */
  readonly notAfter?: string;
}

/**
 * Whether this authorization is one a bounded grant could be derived from — and,
 * emphatically, not a grant, and not a second authorization outcome.
 *
 * Present only when a grant capability is configured. Absent means the Kernel
 * asked no grant question, never that a grant exists or that one would be
 * issuable.
 *
 * ## Why this is a separate field from `status`, and from `obligations`
 *
 * `status` is the authorization decision and stays exactly what the authority
 * and policy layers concluded. `obligations` says whether the action that
 * decision authorized may proceed right now. This says what *bounded permission*
 * that decision would produce. All three are reported side by side and never
 * folded, because `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 makes the
 * distinctions the audit-critical ones.
 *
 * A result reading `status: 'allowed'` with `grants.eligibility: 'ineligible'`
 * is the normal, intended combination — the policy authorized the action and
 * something the grant layer requires is not in place yet. It is never tidied
 * into a denial, and `GRANT_*` codes never appear in `reasonCodes`.
 *
 * ## No grant travels on this field
 *
 * There is no `grant` here, and no grant id, because `evaluate()` issues
 * nothing. Issuance is stateful and transactional and happens through the
 * trusted issuance service, which `evaluate()` does not have and is not given.
 */
export interface GrantEvaluation {
  readonly performed: boolean;
  /** `eligible` or `ineligible`. Deliberately not an allow/deny vocabulary: this is not an authorization outcome and must never be readable as one. */
  readonly eligibility: string;
  /** What a grant derived from this evaluation would be bound to. Derived from the typed request and the Kernel's own decision id; never from a requester-supplied bag. */
  readonly correlation: {
    readonly requestId: string;
    readonly decisionId: string;
    readonly action: string;
    readonly resourceScope: string;
  };
  /** The only party a grant derived from this authorization may be held by. There is no delegation at this layer. */
  readonly subject: string;
  /** The ceiling every bound of such a grant would have to sit at or below, in canonical key order. */
  readonly sourceBounds: readonly GrantBoundEvaluation[];
  /**
   * Why no grant may be derived, from `GRANT_REASON_CODES` — a vocabulary
   * structurally separate from both the authorization reason codes in
   * `reasonCodes` and the exercise reason codes in
   * `obligations.exerciseReasonCodes`. Absent when eligibility is `eligible`.
   */
  readonly ineligibilityReasonCodes?: readonly string[];
  readonly summary?: string;
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
  /**
   * Present only when an `ObligationDischargeProvider` is configured and the
   * deployment declared at least one obligation. Absent means the Kernel asked
   * no obligation question, not that every obligation passed.
   *
   * Reading this never changes how `status` should be read. `status` is the
   * decision; this is whether the decision may be exercised yet.
   */
  readonly obligations?: ObligationEvaluation;
  /**
   * Present only when a grant capability is configured. Absent means the Kernel
   * asked no grant question, not that a grant exists or that one would be
   * issuable.
   *
   * Reading this never changes how `status` should be read. `status` is the
   * decision; `obligations` is whether it may be exercised yet; this is what
   * bounded permission it would produce.
   */
  readonly grants?: GrantEvaluation;
  readonly trace: KernelTrace;
  readonly evaluatedAt: string;
  readonly kernelVersion: string;
  readonly correlationId?: string;
}
