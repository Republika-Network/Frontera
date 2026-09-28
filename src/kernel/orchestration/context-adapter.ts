import {
  contextResolutionDigest,
  readContextFacts,
  unresolvedContextResolution,
  type ContextAttestationVerifier,
  type ContextDeclaration,
  type ContextFactRead,
  type ContextFactValue,
  type ContextObservationRefusalReason,
  type ContextRequirement,
  type ContextResolution,
  type ContextSource,
} from '../../features/context-resolution-runtime/index.js';
import { ContextResolutionService } from '../../features/context-resolution-runtime/index.js';
import type { ContextProvider } from '../contracts/ports.js';
import { assertEffectiveProfileResolver, selectEffectiveProfile, type KernelEffectiveProfileResolver } from './effective-profile.js';
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
  /**
   * CORE-04 — declarations keyed by the effective Governance Profile.
   *
   * A request whose trusted semantics name one of these profiles (by id,
   * version **and** digest — a profile edited under an unchanged version is a
   * different profile) resolves exactly that profile's declaration instead of
   * `declaration`. Built by trusted composition from each profile's material
   * and restrict-only fact classes; a request can neither select nor alter one.
   */
  readonly profileDeclarations?: readonly KernelProfileContextDeclaration[];
  /**
   * CORE-04 — the trusted resolver of a request's **effective** profile from
   * its action and resource (`effective-profile.ts`). Required whenever
   * `profileDeclarations` is non-empty: a request's own semantics never select
   * a declaration.
   */
  readonly resolveEffectiveProfile?: KernelEffectiveProfileResolver;
  /** CORE-04 review — verifies an `attested` source's evidence. Absent, no reading of an `attested` source is admitted. */
  readonly attestationVerifier?: ContextAttestationVerifier;
}

/** CORE-04 — one Governance Profile's context declaration. */
export interface KernelProfileContextDeclaration {
  readonly profile: { readonly id: string; readonly version: number; readonly digest: string };
  readonly declaration: ContextDeclaration;
}

/** The declaration a request resolves against, chosen once per request from trusted semantics only. */
export interface KernelContextSelection {
  readonly service: ContextResolutionService;
  readonly requirements: readonly ContextRequirement[];
  /** `<id>@<version>#<digest>` for a profile declaration; absent for the deployment-wide one. */
  readonly profile?: string;
  /** The effective profile could not be established from trusted configuration: the request is denied `CONTEXT_PROFILE_UNTRUSTED`, never evaluated under a weaker declaration. */
  readonly refused?: true;
}

function profileKey(profile: { readonly id: string; readonly version: number; readonly digest: string }): string {
  return `${profile.id}@${profile.version}#${profile.digest}`;
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
  private readonly byProfile: ReadonlyMap<string, KernelContextSelection>;
  private readonly resolveEffectiveProfile: KernelEffectiveProfileResolver | undefined;

  constructor(options: KernelContextResolutionOptions) {
    assertEffectiveProfileResolver(options.profileDeclarations?.length ?? 0, options.resolveEffectiveProfile, 'Context requirements');
    this.resolveEffectiveProfile = options.resolveEffectiveProfile;
    this.provider = options.provider;
    const attestation = options.attestationVerifier !== undefined ? { attestationVerifier: options.attestationVerifier } : {};
    this.service = new ContextResolutionService({ sources: options.sources, declaration: options.declaration, ...attestation });
    this.requirements = options.declaration.requirements;
    const byProfile = new Map<string, KernelContextSelection>();
    for (const entry of options.profileDeclarations ?? []) {
      const key = profileKey(entry.profile);
      if (byProfile.has(key)) throw new TypeError(`Context is declared twice for Governance Profile ${key}.`);
      byProfile.set(key, {
        service: new ContextResolutionService({ sources: options.sources, declaration: entry.declaration, ...attestation }),
        requirements: entry.declaration.requirements,
        profile: key,
      });
    }
    this.byProfile = byProfile;
  }

  /**
   * The declaration this request resolves against: its **trusted** effective
   * profile's when that profile declares context, the deployment-wide one when
   * the request is unclassified (or its trusted profile declares none), and a
   * refusal when the effective profile cannot be established or the request's
   * semantics disagree with it. Never chosen by the request's claim.
   */
  select(request: KernelEvaluationRequest): KernelContextSelection {
    const effective = selectEffectiveProfile(this.resolveEffectiveProfile, request);
    if (effective.kind === 'refused') return { service: this.service, requirements: [], refused: true };
    const selected = effective.kind === 'profile' ? this.byProfile.get(effective.key) : undefined;
    return selected ?? { service: this.service, requirements: this.requirements };
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

  const selection = capability.select(request);
  // A request whose effective profile is not established resolves nothing and
  // is denied by `resolveKernelContextFacts`; it never falls back to a
  // declaration with fewer required facts.
  if (selection.refused === true) return unresolvedContextResolution({ declaredKeys: [], resolvedAt: at });
  const { service } = selection;
  const keys = service.requestedKeys();
  const declaredKeys = service.declaredKeys();
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
      assertedFactPolicy: service.assertedFactPolicy(),
      assertableKeys: service.assertableKeys(),
      resolvedAt: at,
    });
  }

  if (!Array.isArray(observations)) {
    // A malformed provider result is not an empty world. Fail closed to
    // "consulted and could not answer", exactly as a throw does.
    return unresolvedContextResolution({
      declaredKeys,
      assertedFactPolicy: service.assertedFactPolicy(),
      assertableKeys: service.assertableKeys(),
      resolvedAt: at,
    });
  }

  // CORE-04: admission is scoped to the organization the request is made in —
  // typed request identity, never a claim in the reading or the request body.
  return service.classify(observations, at, request.organization?.id);
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
 * CORE-04 — a required key nothing admissible answered, but that *was* read
 * and refused, is reported by why it was refused: an operator fixing an
 * unauthorized source, a broken connector digest or a skewed clock needs to
 * know which, and "unresolved" alone would send them looking for a missing
 * reading.
 */
const REFUSAL_TO_REASON_CODE: Readonly<Record<ContextObservationRefusalReason, AocKernelReasonCode>> = {
  source_untrusted: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED,
  fact_class_not_attested: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED,
  organization_mismatch: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_SOURCE_NOT_AUTHORIZED,
  provenance_invalid: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID,
  attestation_missing: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID,
  attestation_invalid: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_PROVENANCE_INVALID,
  future_dated: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_TIME_INVALID,
  observation_time_invalid: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_TIME_INVALID,
  value_malformed: AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_MALFORMED,
};

/** CORE-04 — one admitted fact as deterministic policy may read it: its class and value, nothing else. */
export interface AdmittedPolicyFact {
  readonly factClass: string;
  readonly value: ContextFactValue;
}

/**
 * CORE-04 — what policy may read of trusted context: admitted facts only, each
 * in its own list. A fact appears here only when its read is `satisfied` —
 * admitted, fresh, unambiguous and at the declared minimum trust class — so a
 * stale, conflicted, refused, missing or under-trusted fact is simply absent.
 */
export interface AdmittedPolicyContext {
  readonly contextFacts: readonly AdmittedPolicyFact[];
  readonly restrictiveFacts: readonly AdmittedPolicyFact[];
}

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
  /** Empty when every declared-required key was satisfied and no restrict-only key was ambiguous. Non-empty codes are the denial. */
  readonly reasonCodes: readonly AocKernelReasonCode[];
  readonly summary: string;
  /** CORE-04 — the admitted facts policy reads, and only those. */
  readonly admitted: AdmittedPolicyContext;
}

/**
 * Measures the deployment's declared requirements against what was resolved.
 *
 * Only requirements the deployment marked `required: true` can produce a reason
 * code — plus, since CORE-04, a restrict-only requirement whose reading is
 * *ambiguous*: conflicting admitted readings, or no resolution at all. Absence
 * of a restrict-only fact is its baseline and denies nothing; ambiguity denies,
 * because an outage or a second disagreeing source must never be able to
 * suppress a restriction. Everything else is reported and nothing more.
 */
export function resolveKernelContextFacts(capability: KernelContextCapability, resolution: ContextResolution, request: KernelEvaluationRequest): KernelContextFacts {
  const selection = capability.select(request);
  if (selection.refused === true) {
    return {
      evaluation: toContextEvaluation(resolution, selection, []),
      reasonCodes: [AOC_KERNEL_REASON_CODES.CONTEXT_PROFILE_UNTRUSTED],
      summary: "This request's effective Governance Profile could not be established from trusted configuration, or its semantics named a different one; it is not evaluated under any weaker declaration.",
      admitted: { contextFacts: [], restrictiveFacts: [] },
    };
  }
  const reads = readContextFacts(resolution, selection.requirements);
  const evaluation = toContextEvaluation(resolution, selection, reads);
  const unsatisfied = evaluation.unsatisfiedRequirements ?? [];
  const admitted = admittedPolicyContext(selection.requirements, reads);

  if (unsatisfied.length === 0) return { evaluation, reasonCodes: [], summary: '', admitted };

  const restrictive = new Set(selection.requirements.filter((requirement) => requirement.restrictive === true).map((requirement) => requirement.key));
  const reasonCodes: AocKernelReasonCode[] = [];
  const push = (reasonCode: AocKernelReasonCode): void => {
    if (!reasonCodes.includes(reasonCode)) reasonCodes.push(reasonCode);
  };
  for (const entry of unsatisfied) {
    if (restrictive.has(entry.key)) {
      push(AOC_KERNEL_REASON_CODES.CONTEXT_RESTRICTIVE_FACT_AMBIGUOUS);
      continue;
    }
    if (entry.refusalReasons !== undefined && entry.refusalReasons.length > 0) {
      for (const reason of entry.refusalReasons) push(REFUSAL_TO_REASON_CODE[reason as ContextObservationRefusalReason] ?? AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED);
      continue;
    }
    push(READ_STATUS_TO_REASON_CODE[entry.status] ?? AOC_KERNEL_REASON_CODES.CONTEXT_REQUIRED_FACT_UNRESOLVED);
  }

  const described = unsatisfied.map((entry) => `${entry.key} (${entry.status})`).join(', ');
  return {
    evaluation,
    reasonCodes,
    summary: `This deployment declares context it will not evaluate this action without, and it did not resolve: ${described}.`,
    admitted,
  };
}

function admittedPolicyContext(requirements: readonly ContextRequirement[], reads: readonly ContextFactRead[]): AdmittedPolicyContext {
  const restrictive = new Set(requirements.filter((requirement) => requirement.restrictive === true).map((requirement) => requirement.key));
  const contextFacts: AdmittedPolicyFact[] = [];
  const restrictiveFacts: AdmittedPolicyFact[] = [];
  for (const read of reads) {
    if (read.status !== 'satisfied' || read.value === undefined) continue;
    (restrictive.has(read.key) ? restrictiveFacts : contextFacts).push({ factClass: read.key, value: read.value });
  }
  const byClass = (left: AdmittedPolicyFact, right: AdmittedPolicyFact): number => (left.factClass < right.factClass ? -1 : left.factClass > right.factClass ? 1 : 0);
  return { contextFacts: contextFacts.sort(byClass), restrictiveFacts: restrictiveFacts.sort(byClass) };
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
  request: KernelEvaluationRequest,
): KernelEvaluationResult {
  if (capability === undefined || resolution === undefined) return result;

  const facts = resolveKernelContextFacts(capability, resolution, request);
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
function toContextEvaluation(resolution: ContextResolution, selection: KernelContextSelection, reads: readonly ContextFactRead[]): ContextEvaluation {
  const { requirements } = selection;
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
    ...(fact.reference !== undefined ? { reference: fact.reference } : {}),
    ...(fact.provenanceDigest !== undefined ? { provenanceDigest: fact.provenanceDigest } : {}),
  }));

  const requiredKeys = new Set(requirements.filter((requirement) => requirement.required).map((requirement) => requirement.key));
  const restrictiveKeys = new Set(requirements.filter((requirement) => requirement.restrictive === true).map((requirement) => requirement.key));
  const minimumByKey = new Map(requirements.map((requirement) => [requirement.key, requirement.minimumTrustClass]));
  const refusalsByKey = new Map<string, Set<string>>();
  for (const refusal of resolution.refused) {
    const reasons = refusalsByKey.get(refusal.key) ?? new Set<string>();
    reasons.add(refusal.reason);
    refusalsByKey.set(refusal.key, reasons);
  }

  const unsatisfiedRequirements: ContextRequirementEvaluation[] = reads
    .filter((read) => (requiredKeys.has(read.key) && read.status !== 'satisfied') || (restrictiveKeys.has(read.key) && (read.status === 'conflicted' || read.status === 'context_not_resolved')))
    .map((read) => {
      const refusalReasons = read.status === 'unresolved' ? [...(refusalsByKey.get(read.key) ?? [])].sort() : [];
      return {
        key: read.key,
        status: read.status,
        minimumTrustClass: minimumByKey.get(read.key) ?? 'asserted',
        ...(refusalReasons.length > 0 ? { refusalReasons } : {}),
      };
    });

  const assertedFactReads = reads.filter((read) => read.assertedFactReported === true).map((read) => read.key);

  // The decision's validity ceiling: the earliest instant an admitted material
  // fact it relied on goes stale. Restrict-only facts do not cap it — their
  // absence is the baseline, and a restriction that later lapses never widens
  // what was decided.
  let validUntil: string | undefined;
  for (const read of reads) {
    if (read.status !== 'satisfied' || restrictiveKeys.has(read.key)) continue;
    const fact = resolution.facts.find((candidate) => candidate.key === read.key && candidate.resolution === 'resolved');
    const staleAt = fact?.freshness?.staleAt;
    if (staleAt === undefined) continue;
    if (validUntil === undefined || Date.parse(staleAt) < Date.parse(validUntil)) validUntil = staleAt;
  }

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
    ...(resolution.refused.length > 0 ? { refused: resolution.refused.map((entry) => ({ key: entry.key, sourceId: entry.sourceId, reason: entry.reason })) } : {}),
    ...(restrictiveKeys.size > 0 ? { restrictiveKeys: [...restrictiveKeys].sort() } : {}),
    // CORE-04: present only on a profile-declared resolution, so the library
    // path's Governance Record is byte-identical to what it was.
    ...(selection.profile !== undefined ? { digest: contextResolutionDigest(resolution), profile: selection.profile } : {}),
    ...(selection.profile !== undefined && validUntil !== undefined ? { validUntil } : {}),
  };
}
