import type { EnforcementDecision } from '../../features/action-enforcement/domain/enforcement-decision.js';
import type { KernelDecisionStatus } from '../contracts/kernel-result.js';

/**
 * Stable, machine-readable reason code taxonomy. The core set below mirrors
 * the mission's examples verbatim; a documented set of extension codes
 * covers real `EnforcementDecisionType`/policy-id combinations the core set
 * does not distinguish (e.g. dry-run vs. plain allow, adapter denial vs.
 * generic policy denial). Extension codes are additive and never replace a
 * core code where one applies.
 */
export const AOC_KERNEL_REASON_CODES = {
  RECOGNITION_ACTOR_UNKNOWN: 'RECOGNITION_ACTOR_UNKNOWN',
  RECOGNITION_HANDSHAKE_INVALID: 'RECOGNITION_HANDSHAKE_INVALID',
  AUTHORITY_CAPABILITY_MISSING: 'AUTHORITY_CAPABILITY_MISSING',
  AUTHORITY_SCOPE_EXCEEDED: 'AUTHORITY_SCOPE_EXCEEDED',
  AUTHORITY_DELEGATION_EXPIRED: 'AUTHORITY_DELEGATION_EXPIRED',
  POLICY_ACTION_PROHIBITED: 'POLICY_ACTION_PROHIBITED',
  POLICY_CONDITION_UNSATISFIED: 'POLICY_CONDITION_UNSATISFIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_PENDING: 'APPROVAL_PENDING',
  APPROVAL_REJECTED: 'APPROVAL_REJECTED',
  EVIDENCE_REQUIRED: 'EVIDENCE_REQUIRED',
  EVIDENCE_INVALID: 'EVIDENCE_INVALID',
  REQUEST_INVALID: 'REQUEST_INVALID',
  KERNEL_INDETERMINATE: 'KERNEL_INDETERMINATE',
  ACTION_ALLOWED: 'ACTION_ALLOWED',

  // Extension codes: real EnforcementDecisionType/policy-id distinctions the core set does not separately name.
  RECOGNITION_ROGUE_ACTOR: 'RECOGNITION_ROGUE_ACTOR',
  RECOGNITION_PASSPORT_INVALID: 'RECOGNITION_PASSPORT_INVALID',
  RECOGNITION_MISSING: 'RECOGNITION_MISSING',
  AUTHORITY_CAPABILITY_REVOKED: 'AUTHORITY_CAPABILITY_REVOKED',
  ACTION_ALLOWED_DRY_RUN: 'ACTION_ALLOWED_DRY_RUN',
  ACTION_DUPLICATE_SUPPRESSED: 'ACTION_DUPLICATE_SUPPRESSED',
  ADAPTER_DENIED: 'ADAPTER_DENIED',
  EMERGENCY_DENIED: 'EMERGENCY_DENIED',
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  DOMAIN_POLICY_DENIED: 'DOMAIN_POLICY_DENIED',
  IDEMPOTENCY_VIOLATION: 'IDEMPOTENCY_VIOLATION',
  EXECUTION_TIMEOUT_EXCEEDED: 'EXECUTION_TIMEOUT_EXCEEDED',
  SIDE_EFFECT_BOUNDARY_VIOLATION: 'SIDE_EFFECT_BOUNDARY_VIOLATION',
  POST_EXECUTION_RECORD_INVALID: 'POST_EXECUTION_RECORD_INVALID',

  // Governed-authority extension codes. Three, not a taxonomy: these name the
  // three materially different ways a right-scoped authority check fails, and
  // each one tells an operator to do something different. They sit alongside
  // `AUTHORITY_SCOPE_EXCEEDED` rather than replacing it, because that code
  // means "outside the granted resource scope" and these mean "outside the
  // recognized governed-right authority" -- the two are independent checks and
  // collapsing them would make a denial unactionable.
  /** The holder controls none of the requested governed right of this resource -- including the case where it once did and has since transferred it all away. */
  AUTHORITY_GOVERNED_RIGHT_MISSING: 'AUTHORITY_GOVERNED_RIGHT_MISSING',
  /** The holder controls some of the right, but less than was requested -- or a quantity that is not commensurable with it, which is never coerced. */
  AUTHORITY_GOVERNED_SCOPE_EXCEEDED: 'AUTHORITY_GOVERNED_SCOPE_EXCEEDED',
  /** A position exists but not at the instant evaluated: it has ended, or has not yet begun. */
  AUTHORITY_GOVERNED_AUTHORITY_EXPIRED: 'AUTHORITY_GOVERNED_AUTHORITY_EXPIRED',

  // Holder-bound representation codes. Three again, mirroring the three above
  // one-for-one, and deliberately *separate* from them: the two checks fail
  // for disjoint reasons, and a denial has to say which of the two proofs was
  // missing. "The holder does not hold it" and "you may not spend the holder's
  // authority" send an operator to entirely different places.
  //
  // Finer distinctions -- wrong holder, wrong right, wrong action, over
  // ceiling, withdrawn, basis lapsed -- are carried by the
  // `GovernedRepresentationCoverage` outcome reported in the evaluation facts,
  // not multiplied into the public reason vocabulary. Three codes is what an
  // integrator programs against; the outcome is what a reviewer reads.
  /** The requester is not the holder and holds no representation permitting it to exercise that holder's authority for this right and action -- including the case where a representation exists for a *different* holder. This is the code that ends arbitrary holder substitution. */
  AUTHORITY_REPRESENTATION_MISSING: 'AUTHORITY_REPRESENTATION_MISSING',
  /** A representation covers the right and action, but the request exceeds its ceiling -- or names a quantity not commensurable with it, which is never coerced. */
  AUTHORITY_REPRESENTATION_SCOPE_EXCEEDED: 'AUTHORITY_REPRESENTATION_SCOPE_EXCEEDED',
  /** A representation exists but is not exercisable at the instant evaluated: it has ended, has not begun, was withdrawn, or the delegation it rests on is no longer live. */
  AUTHORITY_REPRESENTATION_EXPIRED: 'AUTHORITY_REPRESENTATION_EXPIRED',

  // Trusted-context codes. Four, and they exist only for requirements a
  // deployment explicitly declared `required: true`. Frontera ships no rule
  // about what an unresolved fact means -- ADR-CONTEXT-PROVENANCE-AND-TRUST.md
  // §5 -- so none of these can fire for a deployment that declared nothing, and
  // none of them fires for an optional requirement at any time. When one does
  // fire it is the Kernel acting on the deployment's own declaration, which is
  // hard invariant 6: a required fact denies "because the rule said required,
  // not because the resolver decided".
  //
  // Four rather than one because they send an operator to four different
  // places: fix the source, shorten the refresh, reconcile two systems of
  // record, or re-examine which source is allowed to answer a key.
  /** A declared-required key was not answered -- nothing resolved it, or context resolution itself could not complete. Never means the key has no value. */
  CONTEXT_REQUIRED_FACT_UNRESOLVED: 'CONTEXT_REQUIRED_FACT_UNRESOLVED',
  /** A declared-required key was answered, but the reading is older than the freshness the deployment declared it would accept. */
  CONTEXT_REQUIRED_FACT_STALE: 'CONTEXT_REQUIRED_FACT_STALE',
  /** Two or more configured sources answered a declared-required key differently. Never silently resolved to one side. */
  CONTEXT_REQUIRED_FACT_CONFLICTED: 'CONTEXT_REQUIRED_FACT_CONFLICTED',
  /** A declared-required key was answered at a trust class below the declared minimum -- including a requester-asserted value for a key this deployment has not declared assertable. */
  CONTEXT_REQUIRED_FACT_UNTRUSTED: 'CONTEXT_REQUIRED_FACT_UNTRUSTED',
} as const;

export type AocKernelReasonCode = (typeof AOC_KERNEL_REASON_CODES)[keyof typeof AOC_KERNEL_REASON_CODES];

const RECOGNITION_TYPE_TO_REASON_CODE: Readonly<Record<string, AocKernelReasonCode>> = {
  unrecognized_actor: AOC_KERNEL_REASON_CODES.RECOGNITION_ACTOR_UNKNOWN,
  rogue_actor: AOC_KERNEL_REASON_CODES.RECOGNITION_ROGUE_ACTOR,
  invalid_capability: AOC_KERNEL_REASON_CODES.AUTHORITY_CAPABILITY_MISSING,
  revoked: AOC_KERNEL_REASON_CODES.AUTHORITY_CAPABILITY_REVOKED,
  expired: AOC_KERNEL_REASON_CODES.AUTHORITY_DELEGATION_EXPIRED,
  out_of_scope: AOC_KERNEL_REASON_CODES.AUTHORITY_SCOPE_EXCEEDED,
  policy_violation: AOC_KERNEL_REASON_CODES.POLICY_CONDITION_UNSATISFIED,
  deny: AOC_KERNEL_REASON_CODES.POLICY_ACTION_PROHIBITED,
  invalid_passport: AOC_KERNEL_REASON_CODES.RECOGNITION_PASSPORT_INVALID,
  require_human_approval: AOC_KERNEL_REASON_CODES.APPROVAL_REQUIRED,
  require_more_evidence: AOC_KERNEL_REASON_CODES.EVIDENCE_REQUIRED,
};

/** Policy ids from action-enforcement's own chain (`createDefaultEnforcementPolicyChain`) that gate directly on the recognition verdict -- their failure reason is best explained by refining through `recognitionResult.type`. */
const RECOGNITION_GATED_POLICY_IDS: ReadonlySet<string> = new Set(['recognition_required', 'allow_decision_required']);

/**
 * `recognition_required` fails when there is no usable recognition result at
 * all (`context.recognitionResult` missing or structurally malformed) --
 * `decision.recognitionDecisionType` is then `undefined` (or garbage), so
 * `RECOGNITION_TYPE_TO_REASON_CODE` has nothing to refine through. The
 * policy's own reasonCode (`RECOGNITION_MISSING`/`RECOGNITION_INVALID`,
 * see `recognition-required-policy.ts`) is the only signal available in
 * that case, so it is mapped directly rather than falling back to a vague
 * generic denial code.
 */
const RECOGNITION_REQUIRED_FAILURE_REASON_CODE: Readonly<Record<string, AocKernelReasonCode>> = {
  RECOGNITION_MISSING: AOC_KERNEL_REASON_CODES.RECOGNITION_MISSING,
  RECOGNITION_INVALID: AOC_KERNEL_REASON_CODES.RECOGNITION_MISSING,
};

const POLICY_ID_TO_REASON_CODE: Readonly<Record<string, AocKernelReasonCode>> = {
  emergency_deny: AOC_KERNEL_REASON_CODES.EMERGENCY_DENIED,
  approval_pending: AOC_KERNEL_REASON_CODES.APPROVAL_PENDING,
  evidence_required: AOC_KERNEL_REASON_CODES.EVIDENCE_REQUIRED,
  external_standing: AOC_KERNEL_REASON_CODES.RECOGNITION_HANDSHAKE_INVALID,
  adapter_permission: AOC_KERNEL_REASON_CODES.ADAPTER_DENIED,
  domain_policy_pack: AOC_KERNEL_REASON_CODES.DOMAIN_POLICY_DENIED,
  idempotency: AOC_KERNEL_REASON_CODES.IDEMPOTENCY_VIOLATION,
  execution_timeout: AOC_KERNEL_REASON_CODES.EXECUTION_TIMEOUT_EXCEEDED,
  side_effect_boundary: AOC_KERNEL_REASON_CODES.SIDE_EFFECT_BOUNDARY_VIOLATION,
  post_execution_record: AOC_KERNEL_REASON_CODES.POST_EXECUTION_RECORD_INVALID,
};

const DECISION_TYPE_STATUS: Readonly<Record<string, KernelDecisionStatus>> = {
  execute_allowed: 'allowed',
  dry_run_allowed: 'allowed',
  approval_required: 'approval_required',
  evidence_required: 'approval_required',
  external_handshake_required: 'approval_required',
  execution_blocked: 'denied',
  adapter_denied: 'denied',
  emergency_denied: 'denied',
  expired: 'denied',
  invalid_request: 'denied',
  /**
   * `duplicate_suppressed` carries `allowedToExecute: false` in the wrapped
   * engine (see `EXECUTABLE_DECISION_TYPES` in
   * `enforcement-decision-service.ts` -- only `execute_allowed` is
   * executable). Mapping it to `allowed` would let a caller using
   * `evaluate()` to gate a side effect it manages itself re-run an action
   * the engine has already executed once under this idempotency key and is
   * deliberately refusing to run again. `denied` here means "do not
   * proceed" -- `ACTION_DUPLICATE_SUPPRESSED` in `reasonCodes` (and
   * `execution.status === 'duplicate'` from `enforce()`) still lets a
   * caller distinguish this from a genuine governance denial.
   */
  duplicate_suppressed: 'denied',
};

const DECISION_TYPE_REASON_CODE: Readonly<Record<string, AocKernelReasonCode>> = {
  execute_allowed: AOC_KERNEL_REASON_CODES.ACTION_ALLOWED,
  dry_run_allowed: AOC_KERNEL_REASON_CODES.ACTION_ALLOWED_DRY_RUN,
  duplicate_suppressed: AOC_KERNEL_REASON_CODES.ACTION_DUPLICATE_SUPPRESSED,
  approval_required: AOC_KERNEL_REASON_CODES.APPROVAL_REQUIRED,
  evidence_required: AOC_KERNEL_REASON_CODES.EVIDENCE_REQUIRED,
  external_handshake_required: AOC_KERNEL_REASON_CODES.RECOGNITION_HANDSHAKE_INVALID,
  execution_blocked: AOC_KERNEL_REASON_CODES.POLICY_ACTION_PROHIBITED,
  adapter_denied: AOC_KERNEL_REASON_CODES.ADAPTER_DENIED,
  emergency_denied: AOC_KERNEL_REASON_CODES.EMERGENCY_DENIED,
  expired: AOC_KERNEL_REASON_CODES.REQUEST_EXPIRED,
  invalid_request: AOC_KERNEL_REASON_CODES.REQUEST_INVALID,
};

/** Maps `EnforcementDecisionType` onto the kernel's coarse 4-value `KernelDecisionStatus`. Falls back to `denied` for any future/unknown decision type -- fail closed, never fail open. */
export function mapDecisionTypeToStatus(decisionType: string): KernelDecisionStatus {
  return DECISION_TYPE_STATUS[decisionType] ?? 'denied';
}

/**
 * Builds the ordered, deduplicated kernel reason-code list for a terminal
 * `EnforcementDecision`. Prefers the first *failed* policy result (the
 * actual gate that stopped the chain, per the engine's first-failure-wins
 * evaluation) over the coarser `decision.type`, refining recognition-gated
 * policy failures through `decision.recognitionDecisionType` (the original
 * recognition verdict's `type`, already carried on the decision) when
 * available. Always returns at least one code.
 */
export function mapDecisionToReasonCodes(decision: EnforcementDecision): readonly AocKernelReasonCode[] {
  const codes: AocKernelReasonCode[] = [];
  const firstFailed = decision.policyResults.find((result) => !result.passed);

  if (firstFailed) {
    if (firstFailed.policyId === 'recognition_required') {
      const refined = RECOGNITION_REQUIRED_FAILURE_REASON_CODE[firstFailed.reasonCode];
      if (refined !== undefined) {
        codes.push(refined);
      }
    } else if (RECOGNITION_GATED_POLICY_IDS.has(firstFailed.policyId) && decision.recognitionDecisionType !== undefined) {
      const refined = RECOGNITION_TYPE_TO_REASON_CODE[decision.recognitionDecisionType];
      if (refined !== undefined) {
        codes.push(refined);
      }
    }
    const base = POLICY_ID_TO_REASON_CODE[firstFailed.policyId];
    if (base !== undefined && !codes.includes(base)) {
      codes.push(base);
    }
  }

  const byDecisionType = DECISION_TYPE_REASON_CODE[decision.type];
  if (byDecisionType !== undefined && !codes.includes(byDecisionType)) {
    codes.push(byDecisionType);
  }

  if (codes.length === 0) {
    codes.push(AOC_KERNEL_REASON_CODES.POLICY_ACTION_PROHIBITED);
  }

  return codes;
}
