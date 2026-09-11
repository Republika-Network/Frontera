import {
  ObligationLifecycleService,
  unresolvedObligationResolution,
  type ObligationCorrelation,
  type ObligationDischargeSource,
  type ObligationDeclaration,
  type ObligationInstance,
  type ObligationRequirement,
  type ObligationResolution,
} from '../../features/obligation-runtime/index.js';
import { obligationIsSatisfied, obligationIsTerminal, obligationWithholdsExercise } from '../../features/obligation-runtime/index.js';
import type { ObligationDischargeProvider } from '../contracts/ports.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type {
  DisregardedObligationObservationEvaluation,
  KernelEvaluationResult,
  ObligationEvaluation,
  ObligationInstanceEvaluation,
} from '../contracts/kernel-result.js';
import { AOC_KERNEL_EXERCISE_REASON_CODES, type AocKernelExerciseReasonCode } from '../reason-codes/exercise-reason-codes.js';

/**
 * How a deployment adopts obligations.
 *
 * One option object rather than three loose fields, because the three are
 * meaningless apart: a provider with no declaration resolves nothing, and a
 * declaration with no provider has nothing to resolve it. Supplying the object
 * is the whole of the opt-in; omitting it leaves the Kernel byte-identical to
 * this layer not existing.
 */
export interface KernelObligationOptions {
  readonly provider: ObligationDischargeProvider;
  /** The deployment's configured discharge sources. Operator-provisioned; never named by a requester. */
  readonly sources: readonly ObligationDischargeSource[];
  /** Which obligations stand, which of them block exercise, and how long a discharge of each stays good. */
  readonly declaration: ObligationDeclaration;
}

/**
 * The obligation capability, composed once at Kernel construction.
 *
 * Constructing it here rather than per request is what makes a configuration
 * error a wiring-time failure instead of a decision-time one: a deployment that
 * registers its own request bag as an independent discharge source finds out
 * when it builds the Kernel.
 */
export class KernelObligationCapability {
  readonly provider: ObligationDischargeProvider;
  readonly service: ObligationLifecycleService;
  readonly requirements: readonly ObligationRequirement[];

  constructor(options: KernelObligationOptions) {
    this.provider = options.provider;
    this.service = new ObligationLifecycleService({ sources: options.sources, declaration: options.declaration });
    this.requirements = options.declaration.requirements;
  }
}

/** The correlation an obligation and its discharges are bound to, derived from the typed request and never from a requester-supplied bag. */
export function obligationCorrelationFor(request: KernelEvaluationRequest): ObligationCorrelation {
  return {
    requestId: request.requestId,
    action: request.action.capability ?? request.action.type,
    resourceScope: request.action.resourceScope,
  };
}

/**
 * Resolves the obligations standing over a request, or `undefined` when there
 * are none to resolve.
 *
 * Kept out of `AocKernel` itself so the class stays a composition boundary, and
 * modelled on `context-adapter.ts`, which occupies the adjacent position in the
 * pipeline and honours the same "produce, never decide" contract.
 *
 * ## What `undefined` means, and why it is not `resolved: false`
 *
 * `undefined` means no obligation belongs on this decision at all: no
 * capability is configured, or the deployment declared no obligations. The
 * result is then built exactly as it was before this layer existed, and a
 * deployment that never adopted obligations sees no change whatsoever.
 *
 * `resolved: false` is the *different* fact that a provider was consulted and
 * could not answer. Every blocking obligation then stays `required` and
 * exercise is withheld, because "the approval system is unreadable" and
 * "nobody approved" are both reasons not to proceed, and neither is a reason to
 * proceed.
 *
 * ## Why a provider failure does not throw
 *
 * An unreadable approval system is a fact about the world, and surfacing it as
 * `indeterminate` would rewrite an authorization the policy layers already
 * reached. The decision stands exactly as concluded; only exercise is withheld.
 */
export async function resolveKernelObligations(
  capability: KernelObligationCapability | undefined,
  request: KernelEvaluationRequest,
  at: string,
): Promise<ObligationResolution | undefined> {
  if (capability === undefined) return undefined;

  const declaredTypes = capability.service.declaredTypes();
  if (declaredTypes.length === 0) return undefined;

  const correlation = obligationCorrelationFor(request);
  const query = {
    obligationTypes: declaredTypes,
    correlation,
    actorId: request.actor.id,
    trustDomainId: request.actor.trustDomainId,
    at,
    ...(request.organization?.id !== undefined ? { organizationId: request.organization.id } : {}),
    ...(request.target?.id !== undefined ? { targetId: request.target.id } : {}),
  };

  let observations;
  try {
    observations = (await capability.provider.resolveObligationDischarges(query)).observations;
  } catch {
    return unresolvedObligationResolution({ declaredTypes, obligations: capability.service.declare(correlation, at), resolvedAt: at });
  }

  if (!Array.isArray(observations)) {
    // A malformed provider result is not an empty world. Fail closed to
    // "consulted and could not answer", exactly as a throw does.
    return unresolvedObligationResolution({ declaredTypes, obligations: capability.service.declare(correlation, at), resolvedAt: at });
  }

  return capability.service.resolve(observations, correlation, at);
}

/** One code per unsatisfying state, and the three unsatisfying states are all of them. `verified` and `waived` never appear here because they never withhold. */
const STATE_TO_EXERCISE_REASON_CODE: Readonly<Record<string, AocKernelExerciseReasonCode>> = {
  required: AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_PENDING,
  pending: AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_PENDING,
  discharged: AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_DISCHARGE_UNVERIFIED,
  expired: AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_EXPIRED,
};

/**
 * What the obligation check found, before it has been attached to any result.
 *
 * Separated from the attaching for the reason `KernelContextFacts` is:
 * `evaluate()` attaches it to an already-computed result, while `enforce()`
 * must consult it *before* the executor runs, because a side effect that has
 * already happened cannot be withheld afterwards.
 *
 * Note what is *not* on this shape: no status, no reason code that belongs on a
 * decision, no summary that reads as a denial. `KernelContextFacts.reasonCodes`
 * are authorization reason codes and a non-empty list is a denial; these are
 * exercise reason codes and a non-empty list is a withheld execution over an
 * untouched decision.
 */
export interface KernelObligationFacts {
  readonly evaluation: ObligationEvaluation;
  /** `true` when every *blocking* obligation is satisfied. Non-blocking obligations never affect it. */
  readonly eligible: boolean;
}

/**
 * Measures the deployment's declared obligations against what was observed.
 *
 * The one thing this function must never do is produce an authorization
 * outcome, and it has no way to: its return type carries no status, no decision
 * and no `AocKernelReasonCode`, and the codes it does emit come from a
 * structurally separate union (`exercise-reason-codes.ts`).
 */
export function resolveKernelObligationFacts(resolution: ObligationResolution): KernelObligationFacts {
  const obligations = resolution.obligations.map(toObligationInstanceEvaluation);
  const withholding = resolution.obligations.filter(obligationWithholdsExercise);
  const eligible = withholding.length === 0;

  const exerciseReasonCodes: AocKernelExerciseReasonCode[] = [];
  for (const obligation of withholding) {
    const code = STATE_TO_EXERCISE_REASON_CODE[obligation.state] ?? AOC_KERNEL_EXERCISE_REASON_CODES.OBLIGATION_PENDING;
    if (!exerciseReasonCodes.includes(code)) exerciseReasonCodes.push(code);
  }

  const disregarded: DisregardedObligationObservationEvaluation[] = resolution.disregarded.map((entry) => ({
    obligationType: entry.obligationType,
    sourceId: entry.sourceId,
    outcome: entry.outcome,
    observedAt: entry.observedAt,
    reason: entry.reason,
  }));

  const described = withholding.map((obligation) => `${obligation.obligationType} (${obligation.state})`).join(', ');

  const evaluation: ObligationEvaluation = {
    performed: true,
    resolved: resolution.resolved,
    declaredTypes: resolution.declaredTypes,
    obligations,
    exerciseEligibility: eligible ? 'eligible' : 'blocked',
    allBlockingObligationsSatisfied: eligible,
    ...(exerciseReasonCodes.length > 0 ? { exerciseReasonCodes } : {}),
    ...(eligible
      ? {}
      : {
          summary: `The authorization stands; exercise is withheld until every blocking obligation is discharged: ${described}.`,
        }),
    ...(disregarded.length > 0 ? { disregarded } : {}),
  };

  return { evaluation, eligible };
}

/**
 * Attaches resolved obligations to an evaluated result.
 *
 * Exactly one thing happens here: the obligation evaluation is added to the
 * result. **`status`, `reasonCodes` and `summary` are not read, not compared
 * and not written.** That is not an oversight and not a convention — it is the
 * settling invariant of the phase, and it is testable by deletion: remove every
 * obligation and every discharge from any scenario and the decision this
 * function was handed comes back identical, because this function never had
 * access to change it.
 *
 * Compare `applyContextStep`, which deliberately *does* narrow: a declared
 * context requirement that did not resolve turns a viable outcome into a
 * denial, because the deployment said it would not evaluate the action without
 * that fact. An obligation says something different — the action *was*
 * evaluated, and authorized, subject to a condition — so the two steps sit next
 * to each other in the pipeline and behave oppositely on purpose.
 */
export function applyObligationStep(resolution: ObligationResolution | undefined, result: KernelEvaluationResult): KernelEvaluationResult {
  if (resolution === undefined) return result;
  return { ...result, obligations: resolveKernelObligationFacts(resolution).evaluation };
}

/**
 * Whether a result's status is one the executor could have run under at all.
 *
 * Consulted so an obligation is never reported as the thing that withheld an
 * execution the decision had already stopped: a denial's executor did not run
 * because it was denied, and labelling that "withheld by obligation" would be a
 * second, false reason for one outcome.
 */
export function isExecutableStatus(status: KernelEvaluationResult['status']): boolean {
  return status === 'allowed';
}

function toObligationInstanceEvaluation(instance: ObligationInstance): ObligationInstanceEvaluation {
  return {
    id: instance.id,
    obligationType: instance.obligationType,
    blocking: instance.blocking,
    state: instance.state,
    satisfied: obligationIsSatisfied(instance),
    terminal: obligationIsTerminal(instance),
    withholdsExercise: obligationWithholdsExercise(instance),
    transitions: instance.transitions.map((transition) => ({ from: transition.from, to: transition.to, at: transition.at, reason: transition.reason })),
    ...(instance.discharge !== undefined
      ? {
          discharge: {
            sourceId: instance.discharge.sourceId,
            sourceKind: instance.discharge.sourceKind,
            verificationClass: instance.discharge.verificationClass,
            outcome: instance.discharge.outcome,
            observedAt: instance.discharge.observedAt,
            ...(instance.discharge.subjectId !== undefined ? { subjectId: instance.discharge.subjectId } : {}),
            ...(instance.discharge.reference !== undefined ? { reference: instance.discharge.reference } : {}),
          },
        }
      : {}),
    ...(instance.verification !== undefined
      ? {
          verification: {
            verified: false as const,
            sourceId: instance.verification.sourceId,
            sourceKind: instance.verification.sourceKind,
            verificationClass: instance.verification.verificationClass,
            observedAt: instance.verification.observedAt,
            ...(instance.verification.subjectId !== undefined ? { subjectId: instance.verification.subjectId } : {}),
            ...(instance.verification.reference !== undefined ? { reference: instance.verification.reference } : {}),
          },
        }
      : {}),
    ...(instance.expiresAt !== undefined ? { expiresAt: instance.expiresAt } : {}),
  };
}
