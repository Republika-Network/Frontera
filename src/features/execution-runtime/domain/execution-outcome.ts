import type { BoundedGrantExerciseAssessment } from './grant-exercise-assessment.js';
import type { ExecutionFailureReason, ValidatedExecutionCorrelation } from './execution-adapter-port.js';

/**
 * What happened when an action was attempted under a bounded grant.
 *
 * ## It is not a decision, and it deliberately cannot become one
 *
 * `KernelDecisionStatus` is not overloaded, extended or reused here.
 * `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 and the grant runtime's
 * separate reason-code vocabulary exist to keep "policy said no" apart from
 * "policy said yes and the condition was not met"; folding execution into the
 * decision status would destroy a third distinction on top of those two —
 * "policy said yes, the grant was issued, and the grant is no longer usable".
 *
 * The authorization half of the world is untouched by every value of this type.
 * A grant that expired after a decision concluded `allowed` leaves the decision
 * concluding `allowed`, permanently; what changed is that
 * `status: 'withheld'` and the adapter was not called.
 *
 * ## Every case carries the assessment
 *
 * Including `executed`. "Why did this run?" and "why did this not run?" are the
 * same question asked of the same record, and answering only the second would
 * make a successful execution the one case an auditor cannot reconstruct.
 */
export type ExecutionOutcome =
  | {
      /** The exercise was usable and the adapter completed. */
      readonly status: 'executed';
      readonly assessment: BoundedGrantExerciseAssessment;
      readonly correlation: ValidatedExecutionCorrelation;
      /** The adapter's provider-neutral handle on what it did, when it supplied one. */
      readonly providerRef?: string;
      readonly adapterId: string;
      /** The instant the exercise was assessed at, from the injected clock. */
      readonly exercisedAt: string;
    }
  | {
      /**
       * The exercise was not usable, so **the adapter was not called.**
       *
       * `withheldBy: 'grant-exercise'` is the only value this field takes in
       * this phase, and it is a field rather than an implied constant so a
       * later layer that withholds for its own reason has somewhere to say so
       * without re-shaping the type.
       */
      readonly status: 'withheld';
      readonly withheldBy: 'grant-exercise';
      readonly assessment: BoundedGrantExerciseAssessment;
      readonly correlation: ValidatedExecutionCorrelation;
      readonly exercisedAt: string;
    }
  | {
      /**
       * The exercise was usable, the adapter was called, and the provider did
       * not complete.
       *
       * Distinct from `withheld` on purpose: authority was sufficient and was
       * exercised, and what failed was the provider. Collapsing the two would
       * report a provider outage as an authority problem.
       */
      readonly status: 'execution-failed';
      readonly assessment: BoundedGrantExerciseAssessment;
      readonly correlation: ValidatedExecutionCorrelation;
      readonly adapterId: string;
      readonly reason: ExecutionFailureReason;
      readonly detail?: string;
      readonly exercisedAt: string;
    };
