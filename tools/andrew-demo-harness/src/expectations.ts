import { isDeepStrictEqual } from 'node:util';

import { DemoFailure, type DemoAttemptRecord } from './contracts.js';

/**
 * ANDREW-P0-11 — what each step of the story must observe, as pure checks over
 * canonical replies. An expected block passes only with the exact expected
 * reason; anything else fails with its category. Kept pure so each rule can be
 * proven against the wrong answers a live run never produces.
 */

export const DESTINATION_POLICY_DENIAL = 'DOMAIN_POLICY_DENIED';
export const RECONSIDERATION_ALREADY_REALIZED = 'GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED';
export const CEILING_EXCEEDED = 'FINANCIAL_AUTHORITY_CEILING_EXCEEDED';

export interface GovernedReply {
  readonly body: Readonly<Record<string, unknown>>;
}

export interface Decision {
  readonly decisionId: string;
  readonly evaluationId: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
}

export const decisionOf = (reply: GovernedReply): Decision => (reply.body['decision'] ?? { decisionId: '', evaluationId: '', status: '', reasonCodes: [] }) as Decision;
export const codesOf = (reply: GovernedReply): readonly string[] => (reply.body['reasonCodes'] as readonly string[] | undefined) ?? [];

function unexpected(message: string): never {
  throw new DemoFailure('UNEXPECTED DEMO ASSERTION FAILURE', message);
}

/** A2: the first request is denied by the destination policy — never executed, never denied for another reason. */
export function expectDestinationDenial(reply: GovernedReply): Decision {
  const decision = decisionOf(reply);
  if (reply.body['status'] === 'executed') unexpected('A2: a payment to an unapproved destination executed');
  if (reply.body['status'] !== 'denied' || decision.status !== 'denied') unexpected(`A2: expected the destination-policy denial, got '${String(reply.body['status'])}'`);
  if (!decision.reasonCodes.includes(DESTINATION_POLICY_DENIAL)) unexpected(`A2: wrong denial reason (${decision.reasonCodes.join(', ')})`);
  return decision;
}

/** A3 / A10: a replay answers with the original request's committed decision, unchanged — no re-evaluation. */
export function expectSameDecision(original: GovernedReply, replay: GovernedReply, step: string): void {
  if (replay.body['status'] !== original.body['status'] || replay.body['requestId'] !== original.body['requestId']) unexpected(`${step}: the replay did not return the original request`);
  if (!isDeepStrictEqual(decisionOf(replay), decisionOf(original))) unexpected(`${step}: the replay returned a different decision — a re-evaluation happened`);
}

/** A5: the reconsideration's trace links it to the denied original by request id. */
export function expectLinkedReconsideration(lineage: Readonly<Record<string, unknown>>, originalRequestId: string): void {
  const reconsiders = (lineage['reconsiders'] ?? {}) as Readonly<Record<string, unknown>>;
  if (lineage['role'] !== 'reconsideration' || reconsiders['requestId'] !== originalRequestId || reconsiders['status'] !== 'denied' || typeof lineage['businessIntentId'] !== 'string') {
    unexpected('A5: the reconsideration is not linked to the denied original');
  }
}

/** A5–A7: a reconsideration that did not execute is classified — governance, submission or validation. */
export function reconsiderationFailure(reply: GovernedReply, attempt: DemoAttemptRecord | undefined): DemoFailure {
  const status = String(reply.body['status']);
  if (status === 'denied' || (status === 'withheld' && attempt === undefined)) return new DemoFailure('GOVERNANCE DENIAL', `A6: the reconsideration was ${status} (${codesOf(reply).join(', ')})`);
  if (attempt !== undefined && ['validated-tec', 'expired', 'anomaly'].includes(attempt.state)) return new DemoFailure('XRPL VALIDATION FAILURE', `A7: the XRPL attempt ended '${attempt.state}'`);
  return new DemoFailure('XRPL SUBMISSION FAILURE', `A7: the payment did not reach a validated outcome (status '${status}', attempt '${attempt?.state ?? 'none'}') — reconcile on the ledger before any retry`);
}

/** A9: a second reconsideration of the same original is withheld as already realized — never executed. */
export function expectAlreadyRealized(reply: GovernedReply): void {
  if (reply.body['status'] === 'executed') unexpected('A9: a second reconsideration executed — the intent was realized twice');
  if (reply.body['status'] !== 'withheld' || !codesOf(reply).includes(RECONSIDERATION_ALREADY_REALIZED)) unexpected(`A9: expected ${RECONSIDERATION_ALREADY_REALIZED}, got '${String(reply.body['status'])}' (${codesOf(reply).join(', ')})`);
}

/** B: allowed by the Kernel, withheld at authority issuance for exactly the ceiling — no execution identity, no provider reference. */
export function expectCeilingWithholding(reply: GovernedReply): Decision {
  const decision = decisionOf(reply);
  if (reply.body['status'] === 'executed') unexpected('B: a payment above the authority ceiling executed');
  if (reply.body['status'] !== 'withheld') unexpected(`B: expected withheld at authority issuance, got '${String(reply.body['status'])}'`);
  if (reply.body['withheldBy'] !== 'authority-binding') unexpected(`B: withheld by '${String(reply.body['withheldBy'])}', not authority-binding`);
  if (!isDeepStrictEqual(codesOf(reply), [CEILING_EXCEEDED])) unexpected(`B: wrong reason (${codesOf(reply).join(', ')})`);
  if (decision.status !== 'allowed') unexpected(`B: the Kernel decision is '${decision.status}' — the ceiling must be what stops it`);
  if (reply.body['executionId'] !== undefined || reply.body['providerRef'] !== undefined) unexpected('B: an execution identity or provider reference exists');
  return decision;
}
