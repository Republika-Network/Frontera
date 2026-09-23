import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest } from '../contracts/kernel-request.js';
import { KernelValidationError } from '../errors/kernel-errors.js';
import { toGuardActionRequestInput, validateKernelEvaluationRequest } from '../orchestration/request-adapter.js';
import { assertThrowsInstance } from './assert-helpers.js';

const BASE_REQUEST: KernelEvaluationRequest = {
  requestId: 'req-1',
  actor: { id: 'actor-victor', trustDomainId: 'trust-domain-datasys' },
  action: { type: 'draft_closure_email', resourceScope: 'project:HMP-14665' },
  requestedAt: '2026-01-01T00:00:00.000Z',
};

describe('validateKernelEvaluationRequest', () => {
  it('accepts a well-formed request', () => {
    validateKernelEvaluationRequest(BASE_REQUEST);
  });

  it('rejects an empty requestId', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, requestId: '' }), KernelValidationError);
  });

  it('rejects a missing actor id', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, actor: { ...BASE_REQUEST.actor, id: '' } }), KernelValidationError);
  });

  it('rejects a missing trustDomainId', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, actor: { ...BASE_REQUEST.actor, trustDomainId: '' } }), KernelValidationError);
  });

  it('rejects a missing action type', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, action: { ...BASE_REQUEST.action, type: '' } }), KernelValidationError);
  });

  it('rejects a missing resourceScope', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, action: { ...BASE_REQUEST.action, resourceScope: '' } }), KernelValidationError);
  });

  it('rejects an invalid requestedAt', () => {
    assertThrowsInstance(() => validateKernelEvaluationRequest({ ...BASE_REQUEST, requestedAt: 'not-a-date' }), KernelValidationError);
  });
});

describe('toGuardActionRequestInput', () => {
  it('maps required fields verbatim', () => {
    const result = toGuardActionRequestInput(BASE_REQUEST, undefined);
    assert.equal(result.actorId, 'actor-victor');
    assert.equal(result.trustDomainId, 'trust-domain-datasys');
    assert.equal(result.action, 'draft_closure_email');
    assert.equal(result.resourceScope, 'project:HMP-14665');
    assert.equal(result.actionRequestId, 'req-1');
  });

  it('never mutates the input request', () => {
    const frozen: KernelEvaluationRequest = Object.freeze({ ...BASE_REQUEST, context: Object.freeze({ passportId: 'passport-victor' }) });
    toGuardActionRequestInput(frozen, { dryRun: true });
  });

  it('sets mode to dry_run only when options.dryRun is true', () => {
    assert.equal(toGuardActionRequestInput(BASE_REQUEST, { dryRun: true }).mode, 'dry_run');
    assert.equal(toGuardActionRequestInput(BASE_REQUEST, { dryRun: false }).mode, undefined);
    assert.equal(toGuardActionRequestInput(BASE_REQUEST, undefined).mode, undefined);
  });

  it('builds policyEvaluationInput only when a domain-policy-pack-relevant field is present', () => {
    assert.equal(toGuardActionRequestInput(BASE_REQUEST, undefined).policyEvaluationInput, undefined);

    const withAmount = toGuardActionRequestInput({ ...BASE_REQUEST, action: { ...BASE_REQUEST.action, amount: '500', currency: 'USD' } }, undefined);
    assert.deepEqual(withAmount.policyEvaluationInput, { amount: '500', currency: 'USD' });
  });

  it('forwards principal, capability, target, and prior-proof references only when present', () => {
    const result = toGuardActionRequestInput(
      {
        ...BASE_REQUEST,
        actor: { ...BASE_REQUEST.actor, principalId: 'actor-principal' },
        action: { ...BASE_REQUEST.action, capability: 'project_closure.drafting', riskLevel: 'medium', sideEffectType: 'write' },
        target: { id: 'target-1', type: 'api_handler', name: 'draft', adapterId: 'adapter-1' },
        approvalProofId: 'approval-proof-1',
        visaId: 'visa-1',
      },
      undefined,
    );
    assert.equal(result.principalActorId, 'actor-principal');
    assert.equal(result.capability, 'project_closure.drafting');
    assert.equal(result.targetId, 'target-1');
    assert.equal(result.targetType, 'api_handler');
    assert.equal(result.approvalProofId, 'approval-proof-1');
    assert.equal(result.visaId, 'visa-1');
  });

  it('drops an unrecognized target.type rather than forwarding an invalid EnforcementTargetType', () => {
    const result = toGuardActionRequestInput({ ...BASE_REQUEST, target: { type: 'not-a-real-target-type' } }, undefined);
    assert.equal(result.targetType, undefined);
  });
});
