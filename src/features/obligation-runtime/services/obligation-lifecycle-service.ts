import type { ObligationCorrelation } from '../domain/obligation-correlation.js';
import { obligationCorrelationMatches } from '../domain/obligation-correlation.js';
import {
  dischargeExpiresAt,
  isDischargeFreshAt,
  type DisregardedObligationObservation,
  type ObligationDischargeObservation,
  type ObligationDischargeOutcome,
  type ObligationDischargeRecord,
  type ObligationObservationDisregardReason,
} from '../domain/obligation-discharge.js';
import { declareObligation, obligationWithholdsExercise, type ObligationInstance } from '../domain/obligation-instance.js';
import { validateObligationDeclaration, type ObligationDeclaration, type ObligationRequirement, type ObligationType } from '../domain/obligation-requirement.js';
import type { ObligationResolution } from '../domain/obligation-resolution.js';
import type { ObligationDischargeSource } from '../domain/obligation-source.js';
import { isLegalObligationTransition, type ObligationState } from '../domain/obligation-state.js';
import { transitionObligation } from '../domain/obligation-transition.js';
import type { ObligationTransitionReason } from '../domain/obligation-instance.js';
import { ObligationConfigurationError } from './obligation-configuration-errors.js';
import { ObligationDischargeSourceRegistry } from './obligation-source-registry.js';

export interface ObligationLifecycleServiceOptions {
  readonly sources: readonly ObligationDischargeSource[];
  readonly declaration: ObligationDeclaration;
}

/** One observation that passed every admissibility gate, paired with the source the registry resolved it to. */
interface AdmissibleObservation {
  readonly observation: ObligationDischargeObservation;
  readonly source: ObligationDischargeSource;
  readonly requirement: ObligationRequirement;
}

/**
 * Turns a provider's raw observations into a classified, stably-ordered
 * `ObligationResolution`.
 *
 * Deterministic from the Kernel's perspective, which is the property this layer
 * rests on: given the same declaration, the same observations and the same
 * instant, it produces the same resolution byte for byte. It reads no clock
 * (the instant is passed in), no store, no network and no randomness, and it
 * contains no `eval`, no `new Function` and no expression parser — the only
 * computation it performs is a walk over a seven-node transition table.
 *
 * It produces no authorization outcome. Every output is a statement about
 * obligations; what any of it means for a decision was already decided by the
 * authority and policy layers, and nothing here can revisit it.
 *
 * ## Why state is derived rather than stored
 *
 * Nothing here mutates. An obligation's state is re-derived on every evaluation
 * from (declaration + observations + instant), which buys three properties the
 * phase needs and would otherwise have to defend with tests:
 *
 * - **expiry is a state, not a job.** ADR §6: "derived from the clock at read
 *   time; no job is load-bearing." A stale discharge is stale the moment it is
 *   read, without a sweeper having run.
 * - **repeated evaluation cannot double-discharge.** Two `enforce()` calls over
 *   the same world produce identical instances, because neither consumed
 *   anything.
 * - **the Governance Record of a replay is identical.** There is no accumulated
 *   state for two runs to disagree about.
 *
 * What a production adapter must therefore persist is the *observations* — see
 * `README.md`, "Production persistence expectations".
 */
export class ObligationLifecycleService {
  private readonly registry: ObligationDischargeSourceRegistry;
  private readonly requirementsByType: ReadonlyMap<string, ObligationRequirement>;
  private readonly declared: readonly ObligationType[];

  constructor(options: ObligationLifecycleServiceOptions) {
    const violations = validateObligationDeclaration(options.declaration);
    if (violations.length > 0) throw new ObligationConfigurationError('Obligation declaration is invalid.', violations);

    this.registry = new ObligationDischargeSourceRegistry(options.sources);

    const byType = new Map<string, ObligationRequirement>();
    for (const requirement of options.declaration.requirements) byType.set(requirement.obligationType, requirement);
    this.requirementsByType = byType;
    this.declared = [...new Set(options.declaration.requirements.map((requirement) => requirement.obligationType))].sort();
  }

  /** Exactly the obligation types a provider is asked about: the declared requirements, sorted, and nothing speculative. */
  declaredTypes(): readonly ObligationType[] {
    return this.declared;
  }

  requirements(): readonly ObligationRequirement[] {
    return [...this.requirementsByType.values()];
  }

  sources(): readonly ObligationDischargeSource[] {
    return this.registry.list();
  }

  /** The declared obligations as Layer B hands them over: every one in `required`, before anything has been observed. */
  declare(correlation: ObligationCorrelation, at: string): readonly ObligationInstance[] {
    return this.declared.map((obligationType) =>
      declareObligation({
        obligationType,
        blocking: this.requirementsByType.get(obligationType)?.blocking === true,
        correlation,
        declaredAt: at,
      }),
    );
  }

  /**
   * Classifies observations into lifecycle state.
   *
   * Observations for obligations the deployment did not declare are discarded.
   * That is not tidiness: a provider able to widen the obligation set beyond the
   * declaration could introduce an obligation nobody declared — or, worse,
   * satisfy one by inventing it.
   */
  resolve(observations: readonly ObligationDischargeObservation[], correlation: ObligationCorrelation, at: string): ObligationResolution {
    const instances = new Map<string, ObligationInstance>();
    for (const instance of this.declare(correlation, at)) instances.set(instance.obligationType, instance);

    const disregarded: DisregardedObligationObservation[] = [];
    const admissible: AdmissibleObservation[] = [];
    const staleTypes = new Set<string>();

    for (const observation of sortObservations(observations)) {
      const requirement = this.requirementsByType.get(observation.obligationType);
      if (requirement === undefined) {
        disregarded.push(disregard(observation, 'undeclared_obligation'));
        continue;
      }
      if (!obligationCorrelationMatches(observation.correlation, correlation)) {
        disregarded.push(disregard(observation, 'correlation_mismatch'));
        continue;
      }
      const source = this.registry.get(observation.sourceId);
      if (source === undefined) {
        disregarded.push(disregard(observation, 'unregistered_source'));
        continue;
      }
      if (requirement.maxDischargeAgeSeconds !== undefined && !isDischargeFreshAt(observation.observedAt, requirement.maxDischargeAgeSeconds, at)) {
        // Recorded as stale rather than applied, and remembered so the
        // obligation can be moved to `expired` below — but only if nothing
        // fresh satisfied it, so an old approval can never poison a current one.
        disregarded.push(disregard(observation, 'stale_observation'));
        staleTypes.add(observation.obligationType);
        continue;
      }
      if (observation.outcome === 'waived' && source.verificationClass !== 'independent') {
        // A waiver is the deployment excusing an obligation. A self-reporting
        // source excusing it is the beneficiary excusing itself, which is the
        // self-assertion defect this layer exists to refuse.
        disregarded.push(disregard(observation, 'waiver_not_independent'));
        continue;
      }
      admissible.push({ observation, source, requirement });
    }

    for (const entry of admissible) {
      const current = instances.get(entry.observation.obligationType);
      if (current === undefined) continue;
      const record = dischargeRecordFor(entry);
      const expiresAt =
        record === undefined || entry.requirement.maxDischargeAgeSeconds === undefined
          ? undefined
          : dischargeExpiresAt(entry.observation.observedAt, entry.requirement.maxDischargeAgeSeconds);

      // Every step of the sequence is applied in order and each is legal on its
      // own terms, so the history records the lifecycle that was actually
      // walked. The record and the window are attached on the final step only —
      // the one the obligation comes to rest on.
      const steps = stepsFor(entry.observation.outcome, entry.source.verificationClass);
      let instance = current;
      let refused = false;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] as ObligationStep;
        const last = index === steps.length - 1;
        const outcome = transitionObligation(instance, step.state, at, step.reason, last ? record : undefined, last ? expiresAt : undefined);
        if (outcome.result === 'illegal') {
          disregarded.push(disregard(entry.observation, 'illegal_transition'));
          refused = true;
          break;
        }
        instance = outcome.instance;
      }
      if (refused) continue;
      instances.set(entry.observation.obligationType, instance);
    }

    // Expiry last, and conditional: an obligation only expires when nothing
    // fresh satisfied it. `isLegalObligationTransition` is consulted rather
    // than assumed, so an obligation already resting in a terminal state is
    // left exactly as it is instead of being quietly reopened into `expired`.
    for (const obligationType of staleTypes) {
      const current = instances.get(obligationType);
      if (current === undefined) continue;
      if (!isLegalObligationTransition(current.state, 'expired')) continue;
      const outcome = transitionObligation(current, 'expired', at, 'discharge_window_closed');
      if (outcome.result === 'applied') instances.set(obligationType, outcome.instance);
    }

    const conflictedTypes = conflictedObligationTypes(admissible);
    const resolvedInstances = this.declared.map((obligationType) => {
      const instance = instances.get(obligationType) as ObligationInstance;
      return conflictedTypes.has(obligationType) ? { ...instance, conflicted: true } : instance;
    });

    return {
      resolved: true,
      declaredTypes: [...this.declared],
      obligations: resolvedInstances,
      disregarded: sortDisregarded(disregarded),
      exerciseEligibility: resolvedInstances.some(obligationWithholdsExercise) ? 'blocked' : 'eligible',
      resolvedAt: at,
    };
  }
}

interface ObligationStep {
  readonly state: ObligationState;
  readonly reason: ObligationTransitionReason;
}

/**
 * The one mapping from "what was reported" plus "how the reporter is
 * classified" to "which steps the obligation takes".
 *
 * This function is where ADR §2 lives. `discharged` from an independent source
 * walks all the way to `verified`; the identical report from a self-reporting
 * one stops at `discharged`. Nothing a provider sends changes which branch is
 * taken — only the registry entry does, and only an operator writes those.
 *
 * `refused` is a single step to `rejected`, and deliberately does not walk up
 * to `discharged` first. `rejected` is reachable only from `discharged`, so a
 * refusal of an obligation nobody reported discharging is refused admission
 * rather than being made to fit: ADR §1 gives no edge for it, and inventing one
 * would mean recording a discharge that never happened in order to refute it.
 * The obligation stays where it is and, if it blocks, keeps blocking — the safe
 * direction either way.
 */
function stepsFor(outcome: ObligationDischargeOutcome, verificationClass: ObligationDischargeSource['verificationClass']): readonly ObligationStep[] {
  switch (outcome) {
    case 'pending':
      return [{ state: 'pending', reason: 'discharge_reported' }];
    case 'discharged':
      return verificationClass === 'independent'
        ? [
            { state: 'pending', reason: 'discharge_reported' },
            { state: 'discharged', reason: 'discharge_reported' },
            { state: 'verified', reason: 'discharge_confirmed' },
          ]
        : [
            { state: 'pending', reason: 'discharge_reported' },
            { state: 'discharged', reason: 'discharge_reported' },
          ];
    case 'refused':
      return [{ state: 'rejected', reason: 'discharge_refused' }];
    case 'waived':
      return [{ state: 'waived', reason: 'waiver_recorded' }];
  }
}

/** A discharge record is written for the three outcomes that put an obligation to rest. `pending` reports progress, not a discharge, and writing one for it would attest to an act nobody performed. */
function dischargeRecordFor(entry: AdmissibleObservation): ObligationDischargeRecord | undefined {
  if (entry.observation.outcome === 'pending') return undefined;
  return {
    sourceId: entry.source.id,
    sourceKind: entry.source.kind,
    verificationClass: entry.source.verificationClass,
    outcome: entry.observation.outcome,
    observedAt: entry.observation.observedAt,
    ...(entry.observation.subjectId !== undefined ? { subjectId: entry.observation.subjectId } : {}),
    ...(entry.observation.reference !== undefined ? { reference: entry.observation.reference } : {}),
  };
}

/**
 * Obligations two *independent* sources disagreed about.
 *
 * Only independent outcomes are compared, and the restriction is the whole
 * substance of the rule. An independent source refusing what a self-reporting
 * one claimed is not a disagreement — it is the verification mechanism working
 * exactly as ADR §2 designs it, and it has a state of its own (`rejected`).
 * What has no answer is two *independently* trustworthy sources contradicting
 * each other: one approval system confirming and another refusing.
 *
 * This layer does not pick a winner there. The obligation is marked conflicted
 * and, if it blocks, keeps blocking whatever state the transitions left it in.
 * That is the rule `ContextResolution.conflicted` already sets for two systems
 * of record answering one key differently — "a fact about the world, not a tie
 * to be broken silently" — and the safe direction besides.
 */
function conflictedObligationTypes(admissible: readonly AdmissibleObservation[]): ReadonlySet<string> {
  const outcomesByType = new Map<string, Set<ObligationDischargeOutcome>>();
  for (const entry of admissible) {
    if (entry.source.verificationClass !== 'independent') continue;
    const bucket = outcomesByType.get(entry.observation.obligationType) ?? new Set<ObligationDischargeOutcome>();
    bucket.add(entry.observation.outcome);
    outcomesByType.set(entry.observation.obligationType, bucket);
  }

  const conflicted = new Set<string>();
  for (const [obligationType, outcomes] of outcomesByType) {
    if (outcomes.has('refused') && (outcomes.has('discharged') || outcomes.has('waived'))) conflicted.add(obligationType);
  }
  return conflicted;
}

function disregard(observation: ObligationDischargeObservation, reason: ObligationObservationDisregardReason): DisregardedObligationObservation {
  return {
    obligationType: observation.obligationType,
    sourceId: typeof observation.sourceId === 'string' ? observation.sourceId : '',
    outcome: observation.outcome,
    observedAt: observation.observedAt,
    reason,
  };
}

/** A total order over observations, so the same set applies in the same sequence in every process. */
function sortObservations(observations: readonly ObligationDischargeObservation[]): readonly ObligationDischargeObservation[] {
  return [...observations].sort((left, right) =>
    compare(
      [left.observedAt, left.obligationType, left.sourceId, left.outcome],
      [right.observedAt, right.obligationType, right.sourceId, right.outcome],
    ),
  );
}

function sortDisregarded(entries: readonly DisregardedObligationObservation[]): readonly DisregardedObligationObservation[] {
  return [...entries].sort((left, right) =>
    compare([left.obligationType, left.observedAt, left.sourceId, left.outcome, left.reason], [right.obligationType, right.observedAt, right.sourceId, right.outcome, right.reason]),
  );
}

function compare(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}
