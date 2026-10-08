import {
  exerciseReservationId,
  type ExerciseControlReconciliationPort,
  type ExerciseReservationResolutionBasis,
} from '../../features/exercise-control-runtime/index.js';
import type { ExecutionResolutionEvidenceRecorder } from '../authority-event-stream/recorder.js';
import type { ExecutionAttemptRecord, ExecutionOutcomeAccessContext, ExecutionOutcomeRecord } from '../execution-outcome-store/contracts.js';
import { isExecutionOutcomeStoreError } from '../execution-outcome-store/errors.js';
import type { ExecutionOutcomeReader } from '../execution-outcome-store/outcome-store.js';
import type { ExecutionResolutionRecord, ExecutionResolutionState, RecordExecutionResolutionInput } from '../execution-resolution-store/contracts.js';
import { isExecutionResolutionStoreError } from '../execution-resolution-store/errors.js';
import type { ExecutionResolutionPort } from '../execution-resolution-store/resolution-store.js';
import { isAttestingOperatorRef, isExecutionFailureReason, isOpaqueResolutionIdentifier } from '../execution-resolution-store/validation.js';
import type { ExecutionActivityGuard } from './activity-guard.js';
import { normalizeResolutionAnswer, type ExecutionResolutionQuery, type ResolutionAuthorityComposition } from './authority.js';
import { OPERATOR_ATTESTATION_AUTHORITY_ID } from './operator-attestation.js';
import type {
  OperatorResolutionRequest,
  OperatorResolutionResult,
  ExecutionReconciliationCapacity,
  ExecutionReconciliationRequest,
  ExecutionReconciliationResult,
  ExecutionReconciliationService,
  ExecutionResolutionAdoptionRequest,
  ExecutionResolutionAdoptionResult,
} from './contracts.js';

/**
 * P12 — the trusted reconciliation service.
 *
 * ```
 * reconcile(executionId)
 *   → load + verify the P11 attempt           corrupt → fail closed, authority never asked
 *   → verify the write-ahead claim            prepared-only is not a provider uncertainty
 *   → load the P11 initial observation        confirmed / withheld → not eligible
 *   → load + verify the P12 binding           absent → unbound; never inferred from config
 *   → definitive resolution on record?        → do NOT ask again; finish any pending P7 row
 *   → ask the bound authority ONCE            outside every transaction
 *   → normalize                               anything outside the closed answer → refused
 *   → unresolved?                             → nothing written, nothing released
 *   → append the P12 resolution FIRST         the durable justification
 *   → then the P7 resolution row              capacity follows the definitive answer
 *   → then evidence (P8, Governance)          reports; never load-bearing
 * ```
 *
 * ## It never executes
 *
 * This file holds no execution adapter, no exercise gate and no grant writer,
 * and no path here can reach one. It asks a resolution authority what happened;
 * it never makes anything happen again.
 *
 * ## Crash ordering
 *
 * The resolution commits before any P7 correction. A crash between the two
 * leaves the resolution durable and the capacity conservatively consumed —
 * availability lost, never widened — and the next explicit `reconcile` finds the
 * resolution, does not ask the authority again, and applies the P7 row
 * idempotently. There is no cross-store transaction, and none is pretended.
 *
 * ## Concurrency
 *
 * Calls for the same execution **in this process** share one in-flight
 * reconciliation, so they cost one authority query. Across processes, two
 * read-only lookups may race; the resolution store's `BEGIN IMMEDIATE` admits
 * at most one resolution, identical answers converge, and a different one is
 * `conflict`. No transaction is ever held open across a network call.
 *
 * ## Operator attestation (PROD-03-02)
 *
 * `recordOperatorResolution` is `reconcile` with the authority's answer
 * replaced by an authenticated operator's attestation, for an execution bound
 * (or adopted) to the operator-attestation authority. It holds the execution
 * exclusively through `activity` from before its re-read of P11 and the claim
 * until after its resolution and completion, so a provider observation either
 * is durable before it looks — and wins — or cannot be recorded until it is
 * done.
 */
export interface ExecutionReconciliationServiceOptions {
  readonly outcomes: ExecutionOutcomeReader;
  readonly resolutions: ExecutionResolutionPort;
  readonly composition: ResolutionAuthorityComposition;
  /** Whether the Governance Store holds the write-ahead claim for this execution. Reads the existing claim; there is no second flag. Throws when it cannot be established. */
  readonly claimed: (scope: ExecutionOutcomeAccessContext, evaluationId: string, executionId: string) => Promise<boolean>;
  /** P7's narrow resolution capability, when the deployment composes one. */
  readonly capacity?: ExerciseControlReconciliationPort;
  /** Governance evidence of the resolution — awaited, never load-bearing. */
  readonly governanceEvidence?: (scope: ExecutionOutcomeAccessContext, evaluationId: string, executionId: string, resolution: ExecutionResolutionRecord) => Promise<unknown>;
  /** P8, write-only. */
  readonly evidence?: ExecutionResolutionEvidenceRecorder;
  /** PROD-03-02 — the guard the governed path holds from before its claim to after its observation. Without it, operator attestation is refused as `in-flight`: ordering against a live provider call cannot be shown. */
  readonly activity?: ExecutionActivityGuard;
  readonly now: () => string;
}

type Basis = ExerciseReservationResolutionBasis;

type EligibleBasis =
  | { readonly kind: 'eligible'; readonly outcome: ExecutionOutcomeRecord; readonly basis: Basis; readonly basisObservationDigest?: string; readonly providerRef?: string }
  | { readonly kind: 'stop'; readonly result: Extract<ExecutionReconciliationResult, { readonly outcome: 'not-eligible' | 'basis-unavailable' }> };

export function createExecutionReconciliationService(options: ExecutionReconciliationServiceOptions): ExecutionReconciliationService {
  const { outcomes, resolutions, composition, claimed, capacity, governanceEvidence, evidence, activity, now } = options;
  const inFlight = new Map<string, Promise<ExecutionReconciliationResult>>();

  function report(fact: (recorder: ExecutionResolutionEvidenceRecorder) => void): void {
    if (evidence === undefined) return;
    try {
      fact(evidence);
    } catch {
      // Evidence never changes an established fact.
    }
  }

  /**
   * The eligibility decision, from verified durable state only: a verified P11
   * attempt, the existing write-ahead claim, and an initial observation that is
   * absent or `unconfirmed`. Everything else stops here, before any authority.
   */
  async function eligibility(scope: ExecutionOutcomeAccessContext, executionId: string, concealForeign = false): Promise<EligibleBasis> {
    let outcome: ExecutionOutcomeRecord | undefined;
    try {
      outcome = await outcomes.read(scope, executionId);
    } catch (error) {
      // Operator plane: another organization's execution is indistinguishable from none.
      if (concealForeign && isExecutionOutcomeStoreError(error) && error.code === 'EXECUTION_OUTCOME_TENANT_VIOLATION') return { kind: 'stop', result: { outcome: 'not-eligible', reason: 'no-attempt' } };
      // A corrupt P11 basis cannot be trusted for amount, asset, correlation or
      // reference: it is never reconciled automatically, and never repaired.
      const reason = isExecutionOutcomeStoreError(error) && error.code === 'EXECUTION_OUTCOME_CORRUPT' ? 'outcome-corrupt' : 'outcome-unreadable';
      return { kind: 'stop', result: { outcome: 'basis-unavailable', reason } };
    }
    if (outcome === undefined) return { kind: 'stop', result: { outcome: 'not-eligible', reason: 'no-attempt' } };
    let isClaimed: boolean;
    try {
      isClaimed = await claimed(scope, outcome.attempt.evaluationId, executionId);
    } catch {
      return { kind: 'stop', result: { outcome: 'basis-unavailable', reason: 'claim-unverifiable' } };
    }
    // Prepared is not attempted: without the claim no provider can have been reached.
    if (!isClaimed) return { kind: 'stop', result: { outcome: 'not-eligible', reason: 'not-claimed' } };
    const terminal = outcome.terminal;
    if (terminal === undefined) return { kind: 'eligible', outcome, basis: 'no-initial-observation' };
    const observation = terminal.observation;
    if (observation.kind === 'withheld') return { kind: 'stop', result: { outcome: 'not-eligible', reason: 'withheld' } };
    if (observation.certainty !== 'unconfirmed') return { kind: 'stop', result: { outcome: 'not-eligible', reason: 'initial-observation-definitive' } };
    return {
      kind: 'eligible',
      outcome,
      basis: 'initial-observation-unconfirmed',
      basisObservationDigest: terminal.observationDigest,
      ...(observation.providerRef !== undefined ? { providerRef: observation.providerRef } : {}),
    };
  }

  function queryOf(attempt: ExecutionAttemptRecord, basis: Basis, providerRef: string | undefined): ExecutionResolutionQuery {
    return Object.freeze({
      organizationId: attempt.organizationId,
      executionId: attempt.executionId,
      evaluationId: attempt.evaluationId,
      requestId: attempt.requestId,
      decisionId: attempt.decisionId,
      boundedGrantId: attempt.boundedGrantId,
      action: attempt.action,
      ...(attempt.amount !== undefined ? { amount: Object.freeze({ value: attempt.amount.value, unit: attempt.amount.unit }) } : {}),
      ...(providerRef !== undefined ? { providerRef } : {}),
      basis,
    });
  }

  /**
   * The P7 correction, strictly after the resolution is durable. The row names
   * the resolution digest; the ledger checks it against its own terminal
   * history inside its own `BEGIN IMMEDIATE`.
   */
  async function applyCapacity(attempt: ExecutionAttemptRecord, basis: Basis, resolution: ExecutionResolutionRecord): Promise<ExecutionReconciliationCapacity> {
    if (capacity === undefined) return 'not-composed';
    const reservationId = exerciseReservationId({ boundedGrantId: attempt.boundedGrantId, executionId: attempt.executionId });
    let applied;
    try {
      applied = await capacity.reconcileResolution({
        reservationId,
        executionId: attempt.executionId,
        resolutionDigest: resolution.resolutionDigest,
        resolution: resolution.certainty,
        basis,
        recordedAt: now(),
      });
    } catch {
      // The resolution stands; the capacity stays conservatively consumed.
      return 'pending';
    }
    switch (applied.outcome) {
      case 'applied':
      case 'already-applied': {
        const event = applied.event;
        report((recorder) =>
          recorder.reservationReconciled({
            requestId: attempt.requestId,
            decisionId: attempt.decisionId,
            boundedGrantId: attempt.boundedGrantId,
            executionId: attempt.executionId,
            reservationId: event.reservationId,
            resolution: event.resolution,
            resolutionDigest: event.resolutionDigest,
            recordedAt: event.recordedAt,
          }),
        );
        return 'adjusted';
      }
      case 'not-found':
        return 'no-reservation';
      case 'conflict':
        return 'conflict';
      case 'inconsistent':
        return 'inconsistent';
      default:
        return 'pending';
    }
  }

  /** Everything after a resolution is durable: P7, then evidence. Never asks the authority. */
  async function finish(attempt: ExecutionAttemptRecord, basis: Basis, resolution: ExecutionResolutionRecord, established: 'now' | 'previously'): Promise<ExecutionReconciliationResult> {
    const adjusted = await applyCapacity(attempt, basis, resolution);
    report((recorder) =>
      recorder.executionOutcomeResolved({
        requestId: attempt.requestId,
        evaluationId: attempt.evaluationId,
        decisionId: attempt.decisionId,
        boundedGrantId: attempt.boundedGrantId,
        executionId: attempt.executionId,
        authorityId: resolution.authorityId,
        certainty: resolution.certainty,
        ...(resolution.failure !== undefined ? { failure: resolution.failure } : {}),
        ...(resolution.providerRef !== undefined ? { providerRef: resolution.providerRef } : {}),
        resolutionDigest: resolution.resolutionDigest,
        recordedAt: resolution.recordedAt,
      }),
    );
    if (governanceEvidence !== undefined) {
      try {
        await governanceEvidence({ organizationId: attempt.organizationId }, attempt.evaluationId, attempt.executionId, resolution);
      } catch {
        // Evidence: its failure leaves the resolution and the capacity exactly as they are.
      }
    }
    return Object.freeze({ outcome: 'resolved', established, resolution, capacity: adjusted });
  }

  async function readResolutionState(scope: ExecutionOutcomeAccessContext, executionId: string): Promise<{ readonly state: ExecutionResolutionState | undefined } | { readonly failure: 'resolution-unreadable' | 'resolution-corrupt' }> {
    try {
      return { state: await resolutions.read(scope, executionId) };
    } catch (error) {
      return { failure: isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CORRUPT' ? 'resolution-corrupt' : 'resolution-unreadable' };
    }
  }

  async function reconcileOnce(scope: ExecutionOutcomeAccessContext, executionId: string): Promise<ExecutionReconciliationResult> {
    const basis = await eligibility(scope, executionId);
    if (basis.kind === 'stop') return basis.result;
    const attempt = basis.outcome.attempt;

    const loaded = await readResolutionState(scope, executionId);
    if ('failure' in loaded) return { outcome: 'basis-unavailable', reason: loaded.failure };
    const binding = loaded.state?.binding;
    if (binding === undefined) return { outcome: 'authority-unavailable', reason: 'unbound' };
    if (binding.attemptDigest !== attempt.attemptDigest) return { outcome: 'basis-unavailable', reason: 'binding-inconsistent' };

    const existing = loaded.state?.resolution;
    if (existing !== undefined) {
      // Already definitive: never ask again. Finish whatever the last call left undone.
      if (existing.basisObservationDigest !== basis.basisObservationDigest) return { outcome: 'basis-unavailable', reason: 'resolution-inconsistent' };
      return finish(attempt, basis.basis, existing, 'previously');
    }

    // The binding decides; today's configuration never substitutes another authority.
    const authority = composition.authorities.get(binding.authorityId);
    if (authority === undefined) return { outcome: 'authority-unavailable', reason: 'not-composed' };

    // One query, outside every transaction.
    let raw: unknown;
    try {
      raw = await authority.resolve(queryOf(attempt, basis.basis, basis.providerRef));
    } catch {
      return { outcome: 'authority-unavailable', reason: 'failed' };
    }
    const answer = normalizeResolutionAnswer(raw);
    if (answer === undefined) return { outcome: 'authority-unavailable', reason: 'invalid-answer' };
    // Unresolved stays unresolved: nothing written, nothing released, nothing retried.
    if (answer.outcome === 'unresolved') return { outcome: 'unresolved' };

    const input: RecordExecutionResolutionInput = {
      organizationId: attempt.organizationId,
      executionId,
      attemptDigest: attempt.attemptDigest,
      bindingDigest: binding.bindingDigest,
      ...(basis.basisObservationDigest !== undefined ? { basisObservationDigest: basis.basisObservationDigest } : {}),
      authorityId: binding.authorityId,
      certainty: answer.certainty,
      ...(answer.certainty === 'confirmed-not-completed' ? { failure: answer.failure } : {}),
      ...(answer.providerRef !== undefined ? { providerRef: answer.providerRef } : {}),
      resolvedAt: now(),
    };
    let recorded;
    try {
      recorded = await resolutions.recordResolution(scope, input);
    } catch (error) {
      if (isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CONFLICT') return { outcome: 'conflict' };
      // No durable justification exists, so no capacity moves.
      return { outcome: 'resolution-unrecorded' };
    }
    return finish(attempt, basis.basis, recorded.resolution, recorded.outcome === 'recorded' ? 'now' : 'previously');
  }

  function scopeOf(request: { readonly organizationId?: unknown; readonly executionId?: unknown } | undefined): { readonly scope: ExecutionOutcomeAccessContext; readonly executionId: string } | undefined {
    const organizationId = request?.organizationId;
    const executionId = request?.executionId;
    if (!isOpaqueResolutionIdentifier(organizationId) || !isOpaqueResolutionIdentifier(executionId)) return undefined;
    return { scope: { organizationId }, executionId };
  }

  return Object.freeze({
    async reconcile(request: ExecutionReconciliationRequest): Promise<ExecutionReconciliationResult> {
      const scoped = scopeOf(request);
      if (scoped === undefined) return { outcome: 'not-eligible', reason: 'no-attempt' };
      const key = JSON.stringify([scoped.scope.organizationId, scoped.executionId]);
      const running = inFlight.get(key);
      if (running !== undefined) return running;
      const next = reconcileOnce(scoped.scope, scoped.executionId).finally(() => {
        if (inFlight.get(key) === next) inFlight.delete(key);
      });
      inFlight.set(key, next);
      return next;
    },

    async recordOperatorResolution(request: OperatorResolutionRequest): Promise<OperatorResolutionResult> {
      const scoped = scopeOf(request);
      if (scoped === undefined) return { outcome: 'not-found' };
      const { scope, executionId } = scoped;
      // The closed attestation, checked before anything is read: the operator plane validated it, and this is not the place to start trusting it.
      const certainty = request.certainty;
      const failure = certainty === 'confirmed-not-completed' ? request.failure : undefined;
      if (
        !isAttestingOperatorRef(request.attestedBy) ||
        (request.observedOutcome !== 'none' && request.observedOutcome !== 'unconfirmed') ||
        (certainty !== 'confirmed-completed' && certainty !== 'confirmed-not-completed') ||
        (certainty === 'confirmed-not-completed' && !isExecutionFailureReason(failure))
      ) {
        return { outcome: 'resolution-unrecorded' };
      }
      // Attestation exists only where this deployment composed it; it never stands in for another authority.
      if (!composition.authorities.has(OPERATOR_ATTESTATION_AUTHORITY_ID)) return { outcome: 'authority-mismatch' };
      const release = activity?.tryExclusive(executionId);
      if (release === undefined) return { outcome: 'in-flight' };
      try {
        // Everything below is re-read now, under the exclusive hold — never what the operator's page showed.
        const basis = await eligibility(scope, executionId, true);
        if (basis.kind === 'stop') {
          const stopped = basis.result;
          if (stopped.outcome === 'basis-unavailable') return stopped;
          return stopped.reason === 'no-attempt' ? { outcome: 'not-found' } : { outcome: 'not-eligible', reason: stopped.reason };
        }
        const attempt = basis.outcome.attempt;
        const current = basis.basis === 'no-initial-observation' ? 'none' : 'unconfirmed';
        if (current !== request.observedOutcome) return { outcome: 'basis-changed', current };

        const loaded = await readResolutionState(scope, executionId);
        if ('failure' in loaded) return { outcome: 'basis-unavailable', reason: loaded.failure };
        let binding = loaded.state?.binding;
        if (binding !== undefined && binding.attemptDigest !== attempt.attemptDigest) return { outcome: 'basis-unavailable', reason: 'binding-inconsistent' };
        const existing = loaded.state?.resolution;
        if (existing !== undefined) {
          if (existing.basisObservationDigest !== basis.basisObservationDigest) return { outcome: 'basis-unavailable', reason: 'resolution-inconsistent' };
          const identical = existing.authorityId === OPERATOR_ATTESTATION_AUTHORITY_ID && existing.attestedBy === request.attestedBy && existing.certainty === certainty && existing.failure === failure;
          if (!identical) return { outcome: 'already-resolved', resolution: existing };
          const finished = await finish(attempt, basis.basis, existing, 'previously');
          return { outcome: 'replayed', resolution: existing, requestId: attempt.requestId, evaluationId: attempt.evaluationId, capacity: finished.outcome === 'resolved' ? finished.capacity : 'pending' };
        }
        if (binding === undefined) {
          // Claimed before attestation was composed: adopt — bind, never declare. The same rule as adoptResolutionAuthority.
          try {
            binding = (
              await resolutions.bind(scope, {
                organizationId: attempt.organizationId,
                executionId,
                attemptDigest: attempt.attemptDigest,
                authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID,
                origin: 'adopted',
                boundAt: now(),
              })
            ).binding;
          } catch (error) {
            if (isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CONFLICT') return { outcome: 'authority-mismatch' };
            return { outcome: 'basis-unavailable', reason: 'resolution-unreadable' };
          }
        }
        // The binding decides: an execution another authority may resolve is that authority's.
        if (binding.authorityId !== OPERATOR_ATTESTATION_AUTHORITY_ID) return { outcome: 'authority-mismatch' };

        const input: RecordExecutionResolutionInput = {
          organizationId: attempt.organizationId,
          executionId,
          attemptDigest: attempt.attemptDigest,
          bindingDigest: binding.bindingDigest,
          ...(basis.basisObservationDigest !== undefined ? { basisObservationDigest: basis.basisObservationDigest } : {}),
          authorityId: OPERATOR_ATTESTATION_AUTHORITY_ID,
          certainty,
          ...(failure !== undefined ? { failure } : {}),
          attestedBy: request.attestedBy,
          resolvedAt: now(),
        } as RecordExecutionResolutionInput;
        let recorded;
        try {
          recorded = await resolutions.recordResolution(scope, input);
        } catch (error) {
          if (isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CONFLICT') {
            const after = await readResolutionState(scope, executionId);
            const standing = 'state' in after ? after.state?.resolution : undefined;
            return standing !== undefined ? { outcome: 'already-resolved', resolution: standing } : { outcome: 'resolution-unrecorded' };
          }
          // No durable attestation exists, so no capacity moves and nothing is reported.
          return { outcome: 'resolution-unrecorded' };
        }
        const finished = await finish(attempt, basis.basis, recorded.resolution, recorded.outcome === 'recorded' ? 'now' : 'previously');
        return {
          outcome: recorded.outcome === 'recorded' ? 'recorded' : 'replayed',
          resolution: recorded.resolution,
          requestId: attempt.requestId,
          evaluationId: attempt.evaluationId,
          capacity: finished.outcome === 'resolved' ? finished.capacity : 'pending',
        };
      } finally {
        release();
      }
    },

    async adoptResolutionAuthority(request: ExecutionResolutionAdoptionRequest): Promise<ExecutionResolutionAdoptionResult> {
      const scoped = scopeOf(request);
      if (scoped === undefined) return { outcome: 'not-eligible', reason: 'no-attempt' };
      const authorityId = request.authorityId;
      if (typeof authorityId !== 'string' || !composition.authorities.has(authorityId)) return { outcome: 'authority-not-composed' };
      const basis = await eligibility(scoped.scope, scoped.executionId);
      if (basis.kind === 'stop') return basis.result;
      const loaded = await readResolutionState(scoped.scope, scoped.executionId);
      if ('failure' in loaded) return { outcome: 'basis-unavailable', reason: loaded.failure };
      const attempt = basis.outcome.attempt;
      try {
        const bound = await resolutions.bind(scoped.scope, {
          organizationId: attempt.organizationId,
          executionId: attempt.executionId,
          attemptDigest: attempt.attemptDigest,
          authorityId,
          origin: 'adopted',
          boundAt: now(),
        });
        return { outcome: bound.outcome, binding: bound.binding };
      } catch (error) {
        if (isExecutionResolutionStoreError(error) && error.code === 'EXECUTION_RESOLUTION_CONFLICT') return { outcome: 'conflict' };
        return { outcome: 'basis-unavailable', reason: 'resolution-unreadable' };
      }
    },
  });
}
