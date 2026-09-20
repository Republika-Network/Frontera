import type { KernelEvaluationResult } from '../../kernel/index.js';
import type { GovernanceEvaluationCompletedEvent } from '../events/enterprise-events.js';

/**
 * The evaluation-outcome event every path that commits a Kernel decision to the
 * Governance Store embeds in the aggregate and publishes after commit.
 *
 * Extracted from `evaluate-governance-request.ts` unchanged, so the frozen
 * `POST /api/governance/evaluate` flow and the Governed Action Orchestrator
 * cannot drift apart on what a committed decision's event says. It reads the
 * Kernel's status and reason codes and restates them; it never interprets them.
 */
export function governanceEvaluationEventTypeFor(status: KernelEvaluationResult['status']): GovernanceEvaluationCompletedEvent['type'] {
  switch (status) {
    case 'denied':
      return 'GovernanceEvaluationDenied';
    case 'approval_required':
      return 'GovernanceEvaluationApprovalRequired';
    case 'allowed':
      return 'GovernanceEvaluationCompleted';
    case 'indeterminate':
      return 'GovernanceEvaluationFailed';
  }
}

export function buildGovernanceEvaluationOutcomeEvent(result: KernelEvaluationResult, eventId: string): GovernanceEvaluationCompletedEvent {
  return {
    eventId,
    type: governanceEvaluationEventTypeFor(result.status),
    occurredAt: result.evaluatedAt,
    requestId: result.requestId,
    decisionId: result.decisionId,
    status: result.status,
    reasonCodes: result.reasonCodes,
    kernelVersion: result.kernelVersion,
    ...(result.correlationId !== undefined ? { correlationId: result.correlationId } : {}),
  };
}
