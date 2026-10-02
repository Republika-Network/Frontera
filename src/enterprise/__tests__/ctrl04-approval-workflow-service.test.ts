import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalAuthorityError, type ApprovalAuthorityErrorCode, type ApprovalCommandContext, type ApprovalCommandPort, type ApprovalRequestView } from '../approval-authority/index.js';
import { EnterpriseHttpError } from '../api/enterprise-http-errors.js';
import { createOperatorApprovalService } from '../operator-control/approval-workflow.js';
import { createOperatorAuthenticator } from '../operator-control/operator-authenticator.js';
import type { OperatorRole } from '../operator-control/roles.js';

/**
 * CTRL-04 — the operator approval service against a scripted CORE-05 port.
 *
 * Fast, in-process: proves what the Host service itself does — the organization
 * re-proof, the context it hands CORE-05, and the error mapping — independently
 * of the Host qualification, which proves the same paths end to end.
 */

const ORG = 'org-unit';
const KEY = 'FRONTERA_CTRL04_UNIT_APPROVER_SECRET_0123456789abcdef';
const ID = `approval-request:${'a'.repeat(64)}`;
const DIGEST = `sha256:${'b'.repeat(64)}`;
const AUTH = `Bearer ${KEY}`;

function view(overrides: { organizationId?: string; status?: ApprovalRequestView['state']['status'] } = {}): ApprovalRequestView {
  return {
    approvalRequestId: ID,
    requestId: 'aoc.gar:unit',
    decisionId: 'decision-unit',
    subjectDigest: DIGEST,
    requestedAt: '2026-10-02T00:00:00.000Z',
    superseded: false,
    subject: {
      format: 'frontera.approval-subject.v1',
      organizationId: overrides.organizationId ?? ORG,
      requestId: 'aoc.gar:unit',
      decisionId: 'decision-unit',
      evaluationId: 'evaluation-unit',
      decisionDigest: { requestDigest: DIGEST, evaluationDigest: DIGEST },
      actorId: 'actor-agent',
      action: 'deploy-release',
      resourceScope: 'cluster',
      governanceProfile: 'profile@1#sha256:x',
      actionClass: 'deploy',
      resourceClass: 'cluster',
      decision: { status: 'approval_required', reasonCodes: ['APPROVAL_REQUIRED'], evaluatedAt: '2026-10-02T00:00:00.000Z' },
      requirement: { approverAction: 'approve-release', minimumApprovals: 1, requestTtlSeconds: 3600, approvalValiditySeconds: 900 },
      requirementDigest: DIGEST,
    },
    state: { status: overrides.status ?? 'pending', approvers: [], minimumApprovals: 1, requestExpiresAt: '2026-10-02T01:00:00.000Z', verdicts: [] },
  };
}

function service(port: Partial<ApprovalCommandPort>, role: OperatorRole = 'approver') {
  const logged: Record<string, unknown>[] = [];
  const authenticator = createOperatorAuthenticator({
    administrators: [],
    operators: [{ operatorId: 'approver-unit', role, key: KEY }],
    ordinaryCredentials: [],
    organizationId: ORG,
    isReady: () => true,
    lifecycleState: () => 'ready',
  });
  const unused = () => Promise.reject(new Error('not scripted'));
  const approvals = {
    list: port.list ?? (() => Promise.resolve([view()])),
    approve: port.approve ?? unused,
    reject: port.reject ?? unused,
    requestChanges: port.requestChanges ?? unused,
    escalate: port.escalate ?? unused,
    revoke: port.revoke ?? unused,
  };
  return {
    logged,
    approval: createOperatorApprovalService({
      authenticator,
      organizationId: ORG,
      approvals,
      logger: { debug: () => {}, info: (_m, fields) => logged.push({ ...(fields ?? {}) }), warn: () => {}, error: () => {} },
    }),
  };
}

const body = (extra: Record<string, unknown> = {}) => () => Promise.resolve({ subjectDigest: DIGEST, ...extra });

async function httpError(promise: Promise<unknown>): Promise<EnterpriseHttpError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof EnterpriseHttpError, String(error));
    return error;
  }
  assert.fail('expected a refusal');
}

describe('CTRL-04 operator approval service — against a scripted CORE-05 port', () => {
  it('a request of another organization in the port’s answer is an integrity failure, never data', async () => {
    const { approval } = service({ list: () => Promise.resolve([view({ organizationId: 'org-other' })]) });
    const read = await httpError(approval.listApprovals(AUTH, {}));
    assert.equal(read.httpStatus, 500);
    assert.equal(read.code, 'AUTHORITY_STATE_INTEGRITY_FAILED');
    assert.equal(read.extra?.['failure'], 'APPROVAL_ORGANIZATION_MISMATCH');
    assert.equal((await httpError(approval.command(AUTH, 'approve', ID, body()))).httpStatus, 500);
  });

  it('CORE-05 receives exactly the server-derived context and a field-by-field command', async () => {
    const seen: { context?: ApprovalCommandContext; command?: unknown } = {};
    const { approval } = service({
      approve: (context, command) => {
        seen.context = context;
        seen.command = command;
        return Promise.resolve(view({ status: 'approved' }));
      },
    });
    const result = await approval.command(AUTH, 'approve', ID, body({ reason: 'ticket-1', evidence: [{ type: 'source_document', hash: DIGEST }] }));
    assert.equal(result.outcome, 'recorded');
    assert.deepEqual(seen.context, { authenticated: true, actorId: 'operator:approver-unit', authenticatedBy: 'frontera:operator-plane' });
    assert.deepEqual(seen.command, { approvalRequestId: ID, subjectDigest: DIGEST, evidence: [{ type: 'source_document', hash: DIGEST }], reason: 'ticket-1' });
  });

  it('every CORE-05 refusal maps to its documented answer; none is a success', async () => {
    const cases: readonly [ApprovalAuthorityErrorCode, string | undefined, number, string, string | undefined][] = [
      ['APPROVAL_INVALID', undefined, 400, 'INVALID_REQUEST', undefined],
      ['APPROVAL_APPROVER_INELIGIBLE', 'APPROVER_AUTHORITY_MISSING', 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_APPROVER_INELIGIBLE'],
      ['APPROVAL_APPROVER_INELIGIBLE', 'SEGREGATION_OF_DUTIES_VIOLATION', 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_SEGREGATION_OF_DUTIES'],
      ['APPROVAL_DUPLICATE', 'DUPLICATE_APPROVAL', 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_DUPLICATE'],
      ['APPROVAL_EVIDENCE_INSUFFICIENT', 'APPROVAL_INSUFFICIENT_EVIDENCE', 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_EVIDENCE_INSUFFICIENT'],
      ['APPROVAL_REQUEST_SUPERSEDED', undefined, 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_REQUEST_SUPERSEDED'],
      ['APPROVAL_REQUEST_CLOSED', undefined, 409, 'OPERATOR_OPERATION_REFUSED', 'APPROVAL_REQUEST_CLOSED'],
      ['APPROVAL_STORE_CORRUPT', undefined, 500, 'AUTHORITY_STATE_INTEGRITY_FAILED', 'APPROVAL_STORE_CORRUPT'],
      ['APPROVAL_STORE_UNSUPPORTED', undefined, 500, 'AUTHORITY_STATE_INTEGRITY_FAILED', 'APPROVAL_STORE_UNSUPPORTED'],
      ['APPROVAL_STORE_CLOSED', undefined, 503, 'AUTHORITY_STATE_UNAVAILABLE', undefined],
      ['APPROVAL_CONTEXT_UNTRUSTED', undefined, 503, 'AUTHORITY_STATE_UNAVAILABLE', undefined],
    ];
    for (const [code, reasonCode, status, httpCode, failure] of cases) {
      const { approval } = service({ approve: () => Promise.reject(new ApprovalAuthorityError(code, 'refused', reasonCode)) });
      const error = await httpError(approval.command(AUTH, 'approve', ID, body()));
      assert.equal(error.httpStatus, status, code);
      assert.equal(error.code, httpCode, code);
      assert.equal(error.extra?.['failure'], failure, code);
      if (status === 409) assert.equal(error.extra?.['recorded'], false, code);
    }
  });

  it('a closed request is named by its fresh status; an integrity failure during a command never claims nothing was recorded', async () => {
    const closed = service({ list: () => Promise.resolve([view({ status: 'rejected' })]), approve: () => Promise.reject(new ApprovalAuthorityError('APPROVAL_REQUEST_CLOSED', 'closed')) });
    // The pre-check list still finds the request by id; the refusal is then named from a fresh read.
    const error = await httpError(closed.approval.command(AUTH, 'approve', ID, body()));
    assert.equal(error.extra?.['failure'], 'APPROVAL_REJECTED');
    assert.equal(error.extra?.['approvalStatus'], 'rejected');

    const corrupt = service({ approve: () => Promise.reject(new ApprovalAuthorityError('APPROVAL_STORE_CORRUPT', 'corrupt')) });
    const integrity = await httpError(corrupt.approval.command(AUTH, 'approve', ID, body()));
    assert.match(integrity.message, /Whether the command was recorded is unknown/);
    assert.doesNotMatch(integrity.message, /nothing was changed/i);
    assert.equal(integrity.extra?.['recorded'], undefined, 'the Host does not state recorded either way');
  });

  it('an unexpected port failure is “unavailable — whether recorded is unknown”, never a success; an escalation needs a reference', async () => {
    const { approval } = service({ approve: () => Promise.reject(new Error('disk')), escalate: () => Promise.resolve(view()) });
    const error = await httpError(approval.command(AUTH, 'approve', ID, body()));
    assert.equal(error.httpStatus, 503);
    assert.match(error.message, /unknown/);
    assert.equal((await httpError(approval.command(AUTH, 'escalate', ID, body()))).httpStatus, 400);
    assert.equal((await approval.command(AUTH, 'escalate', ID, body({ reason: 'CAB-1' }))).outcome, 'recorded');
  });

  it('the audit line carries operator, organization, operation, target and outcome only', async () => {
    const { approval, logged } = service({ approve: () => Promise.resolve(view({ status: 'approved' })) });
    await approval.command(AUTH, 'approve', ID, body({ reason: 'sensitive-note' }));
    assert.deepEqual(logged, [{ operatorId: 'approver-unit', organizationId: ORG, operation: 'approve', target: ID, status: 'recorded' }]);
  });
});
