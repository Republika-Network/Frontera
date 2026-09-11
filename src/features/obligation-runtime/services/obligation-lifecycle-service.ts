import type { ObligationCorrelation } from '../domain/obligation-correlation.js';
import { obligationCorrelationMatches } from '../domain/obligation-correlation.js';
import type {
  DisregardedObligationObservation,
  ObligationDischargeObservation,
  ObligationDischargeOutcome,
  ObligationDischargeRecord,
  ObligationObservationDisregardReason,
  ObligationVerificationRecord,
} from '../domain/obligation-discharge.js';
import { declareObligation, obligationWithholdsExercise, type ObligationInstance, type ObligationTransitionReason } from '../domain/obligation-instance.js';
import { validateObligationDeclaration, type ObligationDeclaration, type ObligationRequirement, type ObligationType } from '../domain/obligation-requirement.js';
import type { ObligationResolution } from '../domain/obligation-resolution.js';
import type { ObligationDischargeSource } from '../domain/obligation-source.js';
import { isLegalObligationTransition, isObligationExpiredAt, type ObligationState } from '../domain/obligation-state.js';
import { transitionObligation } from '../domain/obligation-transition.js';
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

interface ObligationStep {
  readonly state: ObligationState;
  readonly reason: ObligationTransitionReason;
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
 * computation it performs is a walk over a six-node transition table.
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
 * - **expiry is a state, not a job.** ADR §6: an obligation at or past its
 *   declared deadline is `expired` the moment it is read, without a sweeper
 *   having run.
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

  /**
   * The declared obligations as layer D materializes them: every one in
   * `required`, before anything has been observed.
   *
   * Layer B declared that these obligations are required; this is layer D
   * turning that declaration into instances it owns and manages — ADR §1,
   * "`required` is a Layer D state, not a Layer B declaration".
   */
  declare(correlation: ObligationCorrelation, at: string): readonly ObligationInstance[] {
    return this.declared.map((obligationType) => {
      const requirement = this.requirementsByType.get(obligationType);
      return declareObligation({
        obligationType,
        blocking: requirement?.blocking === true,
        correlation,
        declaredAt: at,
        ...(requirement?.expiresAt !== undefined ? { expiresAt: requirement.expiresAt } : {}),
      });
    });
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

      // A refused verification is not a lifecycle event. ADR §2: "a failed or
      // unverifiable verification attempt leaves the lifecycle state as
      // `discharged`." It attaches provenance about the attempt and moves
      // nothing — and it is only meaningful against a discharge that exists.
      if (entry.observation.outcome === 'refused') {
        if (current.state !== 'discharged') {
          disregarded.push(disregard(entry.observation, 'verification_not_applicable'));
          continue;
        }
        instances.set(entry.observation.obligationType, { ...current, verification: verificationRecordFor(entry) });
        continue;
      }

      const record = dischargeRecordFor(entry);

      // Every step of the sequence is applied in order and each is legal on its
      // own terms, so the history records the lifecycle that was actually
      // walked. The record is attached on the final step only — the one the
      // obligation comes to rest on.
      const steps = stepsFor(entry.observation.outcome, entry.source.verificationClass);
      let instance = current;
      let refusedAdmission = false;
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index] as ObligationStep;
        const last = index === steps.length - 1;
        const outcome = transitionObligation(instance, step.state, at, step.reason, last ? record : undefined);
        if (outcome.result === 'illegal') {
          disregarded.push(disregard(entry.observation, 'illegal_transition'));
          refusedAdmission = true;
          break;
        }
        instance = outcome.instance;
      }
      if (refusedAdmission) continue;
      instances.set(entry.observation.obligationType, instance);
    }

    // Expiry last, and evaluated against the state the observations left behind
    // — ADR §6, verbatim:
    //
    //     if currentTime >= obligation.expiresAt
    //        and state ∈ { required, pending, discharged }
    //     then state → expired
    //
    // An obligation that declares no deadline never expires. `verified` and
    // `waived` are never disturbed: a satisfied obligation stays satisfied, and
    // a deadline passing afterwards is not a reason to withdraw a condition
    // that was met. `isLegalObligationTransition` is what enforces that, rather
    // than a second copy of the state list.
    for (const obligationType of this.declared) {
      const current = instances.get(obligationType);
      if (current === undefined || current.expiresAt === undefined) continue;
      if (!isObligationExpiredAt(current.expiresAt, at)) continue;
      if (!isLegalObligationTransition(current.state, 'expired')) continue;
      const outcome = transitionObligation(current, 'expired', at, 'deadline_passed');
      if (outcome.result === 'applied') instances.set(obligationType, outcome.instance);
    }

    const resolvedInstances = this.declared.map((obligationType) => instances.get(obligationType) as ObligationInstance);

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

/**
 * The one mapping from "what was reported" plus "how the reporter is
 * classified" to "which steps the obligation takes".
 *
 * This function is where ADR §2 lives. `discharged` from an independent source
 * walks all the way to `verified`; the identical report from a self-reporting
 * one stops at `discharged`. Nothing a provider sends changes which branch is
 * taken — only the registry entry does, and only an operator writes those.
 *
 * `refused` does not appear, because it takes no step at all. It is handled
 * before this function is reached.
 */
function stepsFor(outcome: Exclude<ObligationDischargeOutcome, 'refused'>, verificationClass: ObligationDischargeSource['verificationClass']): readonly ObligationStep[] {
  switch (outcome) {
    case 'pending':
      return [{ state: 'pending', reason: 'activated' }];
    case 'discharged':
      return verificationClass === 'independent'
        ? [
            { state: 'pending', reason: 'activated' },
            { state: 'discharged', reason: 'discharge_reported' },
            { state: 'verified', reason: 'discharge_confirmed' },
          ]
        : [
            { state: 'pending', reason: 'activated' },
            { state: 'discharged', reason: 'discharge_reported' },
          ];
    case 'waived':
      return [{ state: 'waived', reason: 'waiver_recorded' }];
  }
}

/** A discharge record is written for the two outcomes that put an obligation to rest. `pending` reports activation, not a discharge, and writing one for it would attest to an act nobody performed — ADR §1, "What a transition carries". */
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

/** The provenance of a verification attempt that did not succeed. Records who looked and what they cited; changes no state. */
function verificationRecordFor(entry: AdmissibleObservation): ObligationVerificationRecord {
  return {
    verified: false,
    sourceId: entry.source.id,
    sourceKind: entry.source.kind,
    verificationClass: entry.source.verificationClass,
    observedAt: entry.observation.observedAt,
    ...(entry.observation.subjectId !== undefined ? { subjectId: entry.observation.subjectId } : {}),
    ...(entry.observation.reference !== undefined ? { reference: entry.observation.reference } : {}),
  };
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
