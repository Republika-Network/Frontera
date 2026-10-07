import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_TRACE_VERSION, type AuthorityTrace, type AuthorityTraceDecisionPath, type AuthorityTraceFinalState } from '../evidence/trace-contracts.js';
import type { GovernanceRecord, GovernanceReferenceRecord } from '../governance-store/contracts.js';
import { isDefinitiveExecutionEvidence, matchesGovernedPath } from '../governance-store/store-common.js';
import { attentionReasonsOf, classifyAuthorityTrace, operationalViewOf, operationalViewOfEvaluation, operationalViewWithoutTrace, type OperationalRecordSummary } from '../operations/classification.js';
import { ATTENTION_REASONS, OPERATIONAL_STATES, type OperationalState } from '../operations/contracts.js';
import { GOVERNED_PATH_LOG_EVENTS, createGovernedPathLog } from '../operations/governed-path-log.js';
import { createEnterpriseLogger } from '../telemetry/enterprise-logger.js';

/**
 * PROD-03-01 — the pure layers of operational visibility: the one
 * classification of a trace, the attention model, the governed-path evidence
 * filter, and the closed structured log.
 */

const REQUEST = `aoc.gar:${'a'.repeat(32)}`;
const T = '2026-10-07T00:00:00.000Z';

const summary: OperationalRecordSummary = {
  requestId: REQUEST,
  evaluationId: 'evaluation-unit',
  decisionId: 'decision-unit',
  actorId: 'actor-unit',
  actionType: 'action-unit',
  status: 'allowed',
  reasonCodes: [],
  evaluatedAt: T,
  persistedAt: T,
};

interface TraceShape {
  readonly finalState: AuthorityTraceFinalState;
  readonly path?: AuthorityTraceDecisionPath;
  readonly grants?: number;
  readonly issuance?: boolean;
  readonly claimed?: boolean;
  readonly approvals?: readonly string[];
  readonly outcome?: AuthorityTrace['stages']['outcome'];
  readonly resolution?: AuthorityTrace['stages']['resolution'];
}

function traceOf(shape: TraceShape): AuthorityTrace {
  const path = shape.path ?? 'allowed';
  return {
    traceVersion: AUTHORITY_TRACE_VERSION,
    requestId: REQUEST,
    organizationId: 'org-unit',
    evaluationId: 'evaluation-unit',
    decisionId: 'decision-unit',
    ...(path === 'allowed' || path === 'approval_required' ? { executionId: 'aoc.exec:unit' } : {}),
    path,
    finalState: shape.finalState,
    stages: {
      request: { presence: 'recorded', actorId: 'actor-unit', actionType: 'action-unit', resourceScope: 'resource-unit', requestedAt: T, receivedAt: T, payloadDigest: 'sha256:unit' },
      decision: { presence: 'recorded', status: path, reasonCodes: ['CODE_UNIT'], evaluatedAt: T, kernelVersion: 'k', aggregateDigest: 'sha256:a', chainPosition: 1 },
      approval: { presence: shape.approvals !== undefined ? 'recorded' : 'not-applicable', records: (shape.approvals ?? []).map((kind, index) => ({ sequence: index + 1, kind, decisionId: 'decision-unit', subjectDigest: 's', recordedBy: 'r', recordedAt: T, digest: 'd' })) },
      obligations: { presence: 'not-applicable', discharges: [] },
      authority: {
        presence: (shape.grants ?? 0) > 0 || shape.issuance === true ? 'recorded' : 'not-reached',
        grants: Array.from({ length: shape.grants ?? 0 }, (_, index) => ({ presence: 'recorded' as const, grantId: `grant-${index}`, issuedAt: T, exercised: false })),
        ...(shape.issuance === true
          ? { issuance: { presence: 'recorded' as const, outcome: 'withheld' as const, withheldBy: 'authority-binding', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'], requested: { value: '600', unit: 'USD' }, ceiling: { value: '500', unit: 'USD' }, recordedAt: T, records: [] } }
          : {}),
      },
      execution: { presence: shape.claimed === true ? 'recorded' : 'not-reached', ...(shape.claimed === true ? { claim: { presence: 'recorded' as const, claimedAt: T } } : {}) },
      parameters: { presence: 'not-reached' },
      reservation: { presence: 'not-composed' },
      outcome: shape.outcome ?? { presence: 'not-reached' },
      resolution: shape.resolution ?? { presence: 'not-composed' },
      events: { presence: 'recorded', events: [] },
    },
  };
}

const EXPECTED: readonly [TraceShape, OperationalState][] = [
  [{ finalState: 'denied', path: 'denied' }, 'decision-denied'],
  [{ finalState: 'indeterminate', path: 'indeterminate' }, 'decision-indeterminate'],
  [{ finalState: 'approval-pending', path: 'approval_required', approvals: ['requested'] }, 'approval-pending'],
  [{ finalState: 'not-executed', path: 'approval_required', approvals: ['requested', 'rejected'] }, 'approval-not-resumed'],
  [{ finalState: 'not-executed', issuance: true }, 'issuance-withheld'],
  [{ finalState: 'not-executed' }, 'allowed-not-authorized'],
  [{ finalState: 'not-executed', grants: 1 }, 'authorized-not-claimed'],
  [{ finalState: 'not-executed', grants: 1, issuance: true }, 'authorized-not-claimed'],
  [{ finalState: 'withheld-at-exercise', grants: 1, claimed: true, outcome: { presence: 'recorded', kind: 'withheld', withheldBy: 'exercise-control', reasonCodes: ['EXERCISE_CONTROL_LIMIT_EXCEEDED'], recordedAt: T } }, 'withheld-at-exercise'],
  [{ finalState: 'executed-confirmed-completed', grants: 1, claimed: true, outcome: { presence: 'recorded', kind: 'provider', certainty: 'confirmed-completed', recordedAt: T } }, 'executed-succeeded'],
  [{ finalState: 'resolved-confirmed-completed', grants: 1, claimed: true }, 'executed-succeeded'],
  [{ finalState: 'executed-confirmed-not-completed', grants: 1, claimed: true, outcome: { presence: 'recorded', kind: 'provider', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', recordedAt: T } }, 'executed-failed'],
  [{ finalState: 'resolved-confirmed-not-completed', grants: 1, claimed: true }, 'executed-failed'],
  [{ finalState: 'executed-unconfirmed', grants: 1, claimed: true, outcome: { presence: 'recorded', kind: 'provider', certainty: 'unconfirmed', recordedAt: T } }, 'claimed-outcome-unconfirmed'],
  [{ finalState: 'claimed-outcome-unrecorded', grants: 1, claimed: true }, 'claimed-no-outcome'],
  [{ finalState: 'unverifiable', grants: 1, claimed: true }, 'trace-unverifiable'],
  [{ finalState: 'inconsistent' }, 'trace-inconsistent'],
];

describe('PROD-03-01 — one deterministic classification per trace', () => {
  it('every ASSURE-01 final state classifies, and each into exactly the documented operational state', () => {
    for (const [shape, expected] of EXPECTED) assert.equal(classifyAuthorityTrace(traceOf(shape)), expected, `${shape.finalState}/${shape.path ?? 'allowed'}`);
    const covered = new Set(EXPECTED.map(([shape]) => shape.finalState));
    for (const state of ['denied', 'indeterminate', 'approval-pending', 'not-executed', 'withheld-at-exercise', 'executed-confirmed-completed', 'executed-confirmed-not-completed', 'executed-unconfirmed', 'claimed-outcome-unrecorded', 'resolved-confirmed-completed', 'resolved-confirmed-not-completed', 'unverifiable', 'inconsistent'] as const) {
      assert.ok(covered.has(state), state);
    }
  });

  it('is a pure function: the same trace classifies identically, and classifying never changes the trace', () => {
    for (const [shape] of EXPECTED) {
      const trace = traceOf(shape);
      const frozen = JSON.stringify(trace);
      const first = operationalViewOf(trace, summary);
      assert.deepEqual(operationalViewOf(trace, summary), first);
      assert.equal(JSON.stringify(trace), frozen);
    }
  });

  it('every classification belongs to the closed vocabulary', () => {
    for (const [shape] of EXPECTED) assert.ok((OPERATIONAL_STATES as readonly string[]).includes(operationalViewOf(traceOf(shape), summary).classification));
  });
});

describe('PROD-03-01 — the attention model is fact-based and never flags governance working', () => {
  it('attention exactly for a claim with no confirmed outcome and for a trace that cannot be stated', () => {
    const attention = OPERATIONAL_STATES.filter((state) => attentionReasonsOf(state).length > 0);
    assert.deepEqual(attention, ['claimed-outcome-unconfirmed', 'claimed-no-outcome', 'trace-unverifiable', 'trace-inconsistent', 'trace-unavailable']);
    assert.deepEqual(attentionReasonsOf('claimed-no-outcome'), ['EXECUTION_CLAIMED_NO_OUTCOME']);
    assert.deepEqual(attentionReasonsOf('claimed-outcome-unconfirmed'), ['EXECUTION_OUTCOME_UNCONFIRMED']);
    for (const state of OPERATIONAL_STATES) for (const reason of attentionReasonsOf(state)) assert.ok((ATTENTION_REASONS as readonly string[]).includes(reason));
  });

  it('never attention: Kernel denied, issuance withheld, approval pending, confirmed success, confirmed failure, withheld at exercise', () => {
    for (const state of ['decision-denied', 'decision-indeterminate', 'issuance-withheld', 'approval-pending', 'approval-not-resumed', 'executed-succeeded', 'executed-failed', 'withheld-at-exercise', 'authorized-not-claimed', 'allowed-not-authorized', 'evaluation-only'] as const) {
      assert.deepEqual(attentionReasonsOf(state), [], state);
    }
  });

  it('unresolved means claimed with no definitive outcome — and only that', () => {
    const unresolved = EXPECTED.filter(([shape]) => operationalViewOf(traceOf(shape), summary).unresolved).map(([, state]) => state);
    assert.deepEqual(unresolved, ['claimed-outcome-unconfirmed', 'claimed-no-outcome', 'trace-unverifiable']);
  });

  it('no age, clock or threshold enters the model: an hour-old and a year-old claim classify alike', () => {
    const young = traceOf({ finalState: 'claimed-outcome-unrecorded', grants: 1, claimed: true });
    const old = { ...young, stages: { ...young.stages, execution: { presence: 'recorded' as const, claim: { presence: 'recorded' as const, claimedAt: '2025-01-01T00:00:00.000Z' } } } };
    assert.equal(operationalViewOf(young, summary).attentionRequired, operationalViewOf(old, summary).attentionRequired);
  });
});

describe('PROD-03-01 — the operator view states facts and carries no amount, provider or payload', () => {
  it('a withholding shows its layer and recorded codes, not the amounts', () => {
    const view = operationalViewOf(traceOf({ finalState: 'not-executed', issuance: true }), summary);
    assert.deepEqual(view.issuance, { status: 'withheld', withheldBy: 'authority-binding', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'], recordedAt: T });
    assert.doesNotMatch(JSON.stringify(view), /"(requested|ceiling|amount|providerRef|adapterId|routedBy|parameters)"/);
  });

  it('a denial has no invented issuance, claim or outcome', () => {
    const view = operationalViewOf(traceOf({ finalState: 'denied', path: 'denied' }), summary);
    assert.deepEqual(view.issuance, { status: 'not-applicable', withheldBy: null, reasonCodes: [], recordedAt: null });
    assert.deepEqual(view.execution, { claim: 'absent', claimedAt: null });
    assert.equal(view.outcome.status, 'none');
  });

  it('a P12 resolution is read as the outcome source', () => {
    const resolved = traceOf({
      finalState: 'resolved-confirmed-not-completed',
      grants: 1,
      claimed: true,
      outcome: { presence: 'recorded', kind: 'provider', certainty: 'unconfirmed', recordedAt: T },
      resolution: { presence: 'recorded', resolution: { authorityId: 'a', certainty: 'confirmed-not-completed', failure: 'PROVIDER_REJECTED', resolvedAt: '2026-10-08T00:00:00.000Z', resolutionDigest: 'd' } },
    });
    const view = operationalViewOf(resolved, summary);
    assert.deepEqual(view.outcome, { status: 'confirmed-not-completed', source: 'resolution', failure: 'PROVIDER_REJECTED', withheldBy: null, reasonCodes: [], recordedAt: '2026-10-08T00:00:00.000Z' });
    assert.equal(view.unresolved, false);
  });

  it('a record whose trace cannot be built needs attention and states nothing it does not know; an evaluate-route decision is never attention', () => {
    const unavailable = operationalViewWithoutTrace(summary, 'EVIDENCE_TRACE_TOO_LARGE');
    assert.equal(unavailable.classification, 'trace-unavailable');
    assert.deepEqual(unavailable.attentionReasons, ['TRACE_UNAVAILABLE']);
    assert.deepEqual(unavailable.trace, { available: false, finalState: null, failure: 'EVIDENCE_TRACE_TOO_LARGE' });
    assert.equal(unavailable.execution.claim, 'unknown');
    const evaluation = operationalViewOfEvaluation({ ...summary, requestId: 'req-evaluate-1' });
    assert.equal(evaluation.classification, 'evaluation-only');
    assert.equal(evaluation.attentionRequired, false);
  });
});

describe('PROD-03-01 — governed-path evidence selection in the store', () => {
  const ref = (referenceType: GovernanceReferenceRecord['referenceType'], externalId: string, externalVersion?: string): GovernanceReferenceRecord => ({
    referenceId: `${referenceType}:${externalId}:${externalVersion ?? ''}`,
    evaluationId: 'evaluation-unit',
    referenceType,
    externalId,
    createdAt: T,
    ...(externalVersion !== undefined ? { externalVersion } : {}),
  });
  const record = (references: GovernanceReferenceRecord[]): GovernanceRecord => ({ references }) as unknown as GovernanceRecord;

  it('the definitive forms are exactly the ones the execution ledger writes for a definitive answer', () => {
    for (const version of ['executed', 'executed@pilot.recording', 'execution-failed:PROVIDER_REJECTED', 'execution-failed:ADAPTER_ERROR@x', 'withheld:exercise-control:EXERCISE_CONTROL_LIMIT_EXCEEDED', 'withheld:GRANT_EXERCISE_EXPIRED', 'resolved:confirmed-completed', 'resolved:confirmed-not-completed:PROVIDER_REJECTED']) {
      assert.equal(isDefinitiveExecutionEvidence(version), true, version);
    }
    for (const version of [undefined, 'attempt', 'execution-unconfirmed', 'execution-unconfirmed@pilot.recording', 'EXECUTED', 'executedX', 'garbage', '']) assert.equal(isDefinitiveExecutionEvidence(version), false, String(version));
  });

  it('open = a claim with no definitive row for the same execution; claimed and issuance-withheld select what they name', () => {
    const claimOnly = record([ref('execution_record', 'x1', 'attempt')]);
    const unconfirmed = record([ref('execution_record', 'x1', 'attempt'), ref('execution_record', 'x1', 'execution-unconfirmed@a')]);
    const executed = record([ref('execution_record', 'x1', 'attempt'), ref('execution_record', 'x1', 'executed@a')]);
    const resolved = record([ref('execution_record', 'x1', 'attempt'), ref('execution_record', 'x1', 'execution-unconfirmed'), ref('execution_record', 'x1', 'resolved:confirmed-completed')]);
    const otherExecution = record([ref('execution_record', 'x1', 'attempt'), ref('execution_record', 'x2', 'executed')]);
    const withheld = record([ref('issuance_record', 'aoc.gar:x', 'withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED')]);
    const nothing = record([]);
    assert.deepEqual(
      [claimOnly, unconfirmed, executed, resolved, otherExecution, withheld, nothing].map((entry) => [matchesGovernedPath(entry, 'execution-claimed'), matchesGovernedPath(entry, 'execution-open'), matchesGovernedPath(entry, 'issuance-withheld')]),
      [
        [true, true, false],
        [true, true, false],
        [true, false, false],
        [true, false, false],
        [true, true, false],
        [false, false, true],
        [false, false, false],
      ],
    );
  });
});

describe('PROD-03-01 — structured governed-path logging is closed JSON', () => {
  function capture(): { readonly lines: Record<string, unknown>[]; readonly log: ReturnType<typeof createGovernedPathLog> } {
    const lines: Record<string, unknown>[] = [];
    const logger = createEnterpriseLogger('debug', { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) });
    return { lines, log: createGovernedPathLog(logger) };
  }
  const ref = { requestId: REQUEST, evaluationId: 'evaluation-unit', decisionId: 'decision-unit' };

  it('each event is one JSON line with only its closed fields — a richer input cannot widen it', () => {
    const { lines, log } = capture();
    const smuggled = { authorization: 'Bearer SECRET-TOKEN', amount: '600', providerRef: 'provider-ref-x', privateKey: '-----BEGIN PRIVATE KEY-----', body: { a: 1 }, env: process.env };
    log.decision({ ...ref, status: 'denied', reasonCodes: ['CODE_A'], ...smuggled } as Parameters<typeof log.decision>[0]);
    log.issuanceWithheld({ ...ref, withheldBy: 'authority-binding', reasonCodes: ['FINANCIAL_AUTHORITY_CEILING_EXCEEDED'], ...smuggled } as Parameters<typeof log.issuanceWithheld>[0]);
    log.executionClaimed({ ...ref, executionId: 'aoc.exec:1', ...smuggled } as Parameters<typeof log.executionClaimed>[0]);
    log.executionOutcome({ ...ref, executionId: 'aoc.exec:1', outcome: 'unconfirmed', outcomeRecorded: true, reasonCodes: [], ...smuggled } as Parameters<typeof log.executionOutcome>[0]);
    log.unconfirmedExecution({ ...ref, executionId: 'aoc.exec:1', reasonCodes: ['GOVERNED_ACTION_EXECUTION_OUTCOME_UNCONFIRMED'], ...smuggled } as Parameters<typeof log.unconfirmedExecution>[0]);
    assert.deepEqual(
      lines.map((line) => line['message']),
      [GOVERNED_PATH_LOG_EVENTS.decision, GOVERNED_PATH_LOG_EVENTS.issuanceWithheld, GOVERNED_PATH_LOG_EVENTS.executionClaimed, GOVERNED_PATH_LOG_EVENTS.executionOutcome, GOVERNED_PATH_LOG_EVENTS.unconfirmedExecution],
    );
    const allowed = new Set(['level', 'message', 'timestamp', 'requestId', 'evaluationId', 'decisionId', 'executionId', 'status', 'reasonCodes', 'withheldBy', 'outcome', 'outcomeRecorded', 'operationalState', 'attentionRequired']);
    for (const line of lines) {
      for (const field of Object.keys(line)) assert.ok(allowed.has(field), `unexpected log field '${field}'`);
      assert.doesNotMatch(JSON.stringify(line), /SECRET-TOKEN|PRIVATE KEY|provider-ref-x|"600"/);
    }
    assert.equal(lines[0]?.['operationalState'], 'decision-denied');
    assert.equal(lines[1]?.['operationalState'], 'issuance-withheld');
    assert.equal(lines[1]?.['attentionRequired'], false);
    assert.equal(lines[3]?.['operationalState'], 'claimed-outcome-unconfirmed');
    assert.equal(lines[3]?.['attentionRequired'], true);
    assert.equal(lines[4]?.['level'], 'warn');
  });

  it('an outcome whose observation was not made durable is logged as a claim with no outcome', () => {
    const { lines, log } = capture();
    log.executionOutcome({ ...ref, executionId: 'aoc.exec:1', outcome: 'confirmed-completed', outcomeRecorded: false, reasonCodes: ['GOVERNED_ACTION_EXECUTION_OUTCOME_UNRECORDED'] });
    assert.equal(lines[0]?.['operationalState'], 'claimed-no-outcome');
    assert.equal(lines[0]?.['attentionRequired'], true);
  });

  it('an allowed decision states no operational state yet — what follows decides it', () => {
    const { lines, log } = capture();
    log.decision({ ...ref, status: 'allowed', reasonCodes: [] });
    assert.equal(lines[0]?.['operationalState'], undefined);
  });
});
