import {
  readContextFacts,
  unresolvedContextResolution,
  type ContextDeclaration,
  type ContextFactRead,
  type ContextRequirement,
  type ContextResolution,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { ContextResolutionService } from '../../features/context-resolution-runtime/index.js';
import type { ContextProvider } from '../contracts/ports.js';
import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import type { ContextEvaluation, ContextFactEvaluation, ContextRequirementEvaluation, KernelEvaluationResult } from '../contracts/kernel-result.js';
import { AOC_KERNEL_REASON_CODES, type AocKernelReasonCode } from '../reason-codes/reason-codes.js';

/**
 * How a deployment adopts trusted context.
 *
 * One option object rather than three loose fields, because the three are
 * meaningless apart: a provider with no declaration resolves nothing, and a
 * declaration with no provider has nothing to resolve it. Supplying the object
 * is the whole of the opt-in; omitting it leaves the Kernel byte-identical to
 * this layer not existing.
 */
export interface KernelContextResolutionOptions {
  readonly provider: ContextProvider;
  /** The deployment's configured context sources. Operator-provisioned; never named by a requester. */
  readonly sources: readonly ContextSource[];
  /** Which keys to resolve, at what minimum trust class, within what freshness, and which of them the deployment will not proceed without. */
  readonly declaration: ContextDeclaration;
}

/**
 * The context capability, composed once at Kernel construction.
 *
 * Constructing it here rather than per request is what makes a configuration
 * error a wiring-time failure instead of a decision-time one: a deployment that
 * mis-declares a source finds out when it builds the Kernel.
 */
export class KernelContextCapability {
  readonly provider: ContextProvider;
  readonly service: ContextResolutionService;
  readonly requirements: readonly ContextRequirement[];

  constructor(options: KernelContextResolutionOptions) {
    this.provider = options.provider;
    this.service = new ContextResolutionService({ sources: options.sources, declaration: options.declaration });
    this.requirements = options.declaration.requirements;
  }
}

/**
 * Resolves the trusted context a request's policy evaluation may consult, or
 * `undefined` when there is none to resolve.
 *
 * Kept out of `AocKernel` itself so the class stays a composition boundary, and
 * modelled on `governed-constraint-adapter.ts`, which occupies the same
 * position in the pipeline and honours the same facts-only contract.
 *
 * ## What `undefined` means, and why it is not `resolved: false`
 *
 * `undefined` means no context belongs in this request's policy input at all:
 * no capability is configured, or the deployment declared no requirements. The
 * policy input is then built exactly as it was before this layer existed, and a
 * deployment that never adopted context sees no change whatsoever.
 *
 * `resolved: false` is the *different* fact that a resolver was consulted and
 * could not answer. That reaches policy, because "the ERP could not be read"
 * and "the vendor has no status" must never be the same input to a rule.
 *
 * ## Why a provider failure does not throw
 *
 * An unreadable context source is a fact about the world, and this layer's
 * whole discipline is to report facts rather than to decide what they mean.
 * Surfacing it as `indeterminate` would be Frontera deciding, for every
 * deployment, that an ERP outage is an inconclusive evaluation. What happens
 * next is instead determined by the deployment's own declaration: a `required`
 * key denies, an optional one is reported and the request proceeds.
 */
export async function resolveKernelContext(
  capability: KernelContextCapability | undefined,
  request: KernelEvaluationRequest,
  at: string,
): Promise<ContextResolution | undefined> {
  if (capability === undefined) return undefined;

  const keys = capability.service.requestedKeys();
  const declaredKeys = capability.service.declaredKeys();
  if (declaredKeys.length === 0) return undefined;

  const query = {
    keys,
    actorId: request.actor.id,
    trustDomainId: request.actor.trustDomainId,
    action: request.action.capability ?? request.action.type,
    resourceScope: request.action.resourceScope,
    at,
    ...(request.organization?.id !== undefined ? { organizationId: request.organization.id } : {}),
    ...(request.target?.id !== undefined ? { targetId: request.target.id } : {}),
  };

  // A derivation-only declaration still needs a resolution object built, so the
  // resolver is skipped rather than the whole step when there is nothing to ask
  // for.
  let observations;
  try {
    observations = keys.length === 0 ? [] : (await capability.provider.resolveContext(query)).observations;
  } catch {
    return unresolvedContextResolution({
      declaredKeys,
      assertedFactPolicy: capability.service.assertedFactPolicy(),
      assertableKeys: capability.service.assertableKeys(),
      resolvedAt: at,
    });
  }

  if (!Array.isArray(observations)) {
    // A malformed provider result is not an empty world. Fail closed to
    // "consulted and could not answer", exactly as a throw does.
    return unresolvedContextResolution({
      declaredKeys,
      assertedFactPolicy: capability.service.assertedFactPolicy(),
      assertableKeys: capability.service.assertableKeys(),
      resolvedAt: at,
    });
  }

  return capability.service.classify(observations, at);
}

/** The outcomes this step may narrow: the ones the existing chain has not already stopped. Anything else is left exactly as it was. */
const VIABLE_STATUSES: ReadonlySet<KernelEvaluationResult['status']> = new Set(['allowed', 'approval_required']);

const READ_STATUS_TO_REASON_CODE: Readonly<Record<string, AocKernelReasonCode>> = {
  context_not_resolved: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED,
  undeclared: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED,
  unresolved: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED,
  stale: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_STALE,
  conflicted: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_CONFLICTED,
  insufficient_trust: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNTRUSTED,
  asserted_not_declared: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNTRUSTED,
};

/**
 * What the context check found, before it has been folded into any decision.
 *
 * Separated from the folding for the reason `GovernedAuthorityFacts` is:
 * `evaluate()` folds it into an already-computed result, while `enforce()` must
 * consult it *before* the executor runs, because a side effect that has already
 * happened cannot be denied afterwards.
 */
export interface KernelContextFacts {
  readonly evaluation: ContextEvaluation;
  /** Empty when every declared-required key was satisfied. Non-empty codes are the denial. */
  readonly reasonCodes: readonly AocKernelReasonCode[];
  readonly summary: string;
}

/**
 * Measures the deployment's declared requirements against what was resolved.
 *
 * Only requirements the deployment marked `required: true` can produce a reason
 * code. Everything else is reported and nothing more — Frontera ships no rule
 * about what an unresolved fact means, and an optional requirement is exactly a
 * deployment declining to state one.
 */
export function resolveKernelContextFacts(capability: KernelContextCapability, resolution: ContextResolution): KernelContextFacts {
  const reads = readContextFacts(resolution, capability.requirements);
  const evaluation = toContextEvaluation(resolution, capability.requirements, reads);
  const unsatisfied = evaluation.unsatisfiedRequirements ?? [];

  if (unsatisfied.length === 0) return { evaluation, reasonCodes: [], summary: '' };

  const reasonCodes: AocKernelReasonCode[] = [];
  for (const entry of unsatisfied) {
    const reasonCode = READ_STATUS_TO_REASON_CODE[entry.status] ?? AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED;
    if (!reasonCodes.includes(reasonCode)) reasonCodes.push(reasonCode);
  }

  const described = unsatisfied.map((entry) => `${entry.key} (${entry.status})`).join(', ');
  return {
    evaluation,
    reasonCodes,
    summary: `This deployment declares context it will not evaluate this action without, and it did not resolve: ${described}.`,
  };
}

/**
 * Folds resolved context into an evaluated result.
 *
 * Two things happen here and nothing else: the provenance of what was resolved
 * is attached to the result, and a viable outcome is narrowed into a denial
 * when a requirement the *deployment* marked `required: true` was not met.
 *
 * ## Why this narrows and never widens
 *
 * An outcome the existing chain already denied never reaches the narrowing
 * branch, so satisfied context cannot rescue anything and cannot upgrade an
 * `approval_required` to `allowed`. Resolved context is an additional way for a
 * request to stop, never a new way for one to proceed. That is the same
 * discipline the governed-authority step follows, and it is what lets a
 * deployment adopt this layer without auditing what it might now permit.
 *
 * ## Why the denial is not the context layer deciding
 *
 * The context layer produced facts; the deployment's declaration said the
 * request must not be evaluated without them; `AocKernel` concluded. Remove the
 * `required: true` and the identical facts change no outcome anywhere — which
 * is the test that settles whether layer C decided anything.
 */
export function applyContextStep(
  capability: KernelContextCapability | undefined,
  resolution: ContextResolution | undefined,
  result: KernelEvaluationResult,
): KernelEvaluationResult {
  if (capability === undefined || resolution === undefined) return result;

  const facts = resolveKernelContextFacts(capability, resolution);
  if (!VIABLE_STATUSES.has(result.status) || facts.reasonCodes.length === 0) {
    return { ...result, context: facts.evaluation };
  }

  return {
    ...result,
    status: 'denied',
    reasonCodes: facts.reasonCodes,
    summary: facts.summary,
    context: facts.evaluation,
  };
}

/**
 * Projects a resolution into the shape that travels on the decision.
 *
 * Fact *values* are dropped here and nowhere else, which is the single point at
 * which the ADR's "values hidden by default" rule is enforced. Everything that
 * reaches a Governance Record passes through this function.
 */
function toContextEvaluation(
  resolution: ContextResolution,
  requirements: readonly ContextRequirement[],
  reads: readonly ContextFactRead[],
): ContextEvaluation {
  const facts: ContextFactEvaluation[] = resolution.facts.map((fact) => ({
    key: fact.key,
    sourceId: fact.sourceId,
    sourceKind: fact.sourceKind,
    trustClass: fact.trustClass,
    effectiveTrustClass: fact.effectiveTrustClass,
    resolution: fact.resolution,
    observedAt: fact.observedAt,
    ...(fact.freshness !== undefined ? { staleAt: fact.freshness.staleAt } : {}),
    ...(fact.conflictingSourceIds !== undefined ? { conflictingSourceIds: fact.conflictingSourceIds } : {}),
  }));

  const requiredKeys = new Set(requirements.filter((requirement) => requirement.required).map((requirement) => requirement.key));
  const minimumByKey = new Map(requirements.map((requirement) => [requirement.key, requirement.minimumTrustClass]));

  const unsatisfiedRequirements: ContextRequirementEvaluation[] = reads
    .filter((read) => read.status !== 'satisfied' && requiredKeys.has(read.key))
    .map((read) => ({ key: read.key, status: read.status, minimumTrustClass: minimumByKey.get(read.key) ?? 'asserted' }));

  const assertedFactReads = reads.filter((read) => read.assertedFactReported === true).map((read) => read.key);

  return {
    performed: true,
    resolved: resolution.resolved,
    declaredKeys: resolution.declaredKeys,
    facts,
    unresolved: resolution.unresolved,
    stale: resolution.stale,
    conflicted: resolution.conflicted,
    assertedFactPolicy: resolution.assertedFactPolicy,
    ...(assertedFactReads.length > 0 ? { assertedFactReads } : {}),
    ...(unsatisfiedRequirements.length > 0 ? { unsatisfiedRequirements } : {}),
  };
}
