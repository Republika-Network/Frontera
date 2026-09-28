import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { KernelEvaluationRequest, KernelEvaluationResult } from '../index.js';
import { KernelValidationError } from '../errors/kernel-errors.js';
import { KernelGrantCapability, deriveGrantSourceAuthorization } from '../orchestration/grant-adapter.js';
import { toGuardActionRequestInput, validateKernelEvaluationRequest } from '../orchestration/request-adapter.js';
import { assertThrowsInstance } from './assert-helpers.js';

/**
 * CORE-03 — what the Kernel does with typed semantics: shape-checks them
 * closed, carries them into the policy input as typed fields (never into the
 * resolved-facts `metadata`), and projects them into the grant source as the
 * profile identity axis and typed parameter bounds. It decides nothing about
 * what any class or dimension *means*.
 */

const DIGEST = `sha256:${'9'.repeat(64)}`;
const SEMANTICS = { actionClass: 'export', resourceClass: 'customer_dataset', governanceProfile: { id: 'customer-data-export', version: 2, digest: DIGEST } };
const REQUEST: KernelEvaluationRequest = {
  requestId: 'req-1',
  actor: { id: 'agent-a', trustDomainId: 'td' },
  organization: { id: 'org-a' },
  action: {
    type: 'export-customer-records',
    resourceScope: 'customer-data-example',
    semantics: SEMANTICS,
    governedParameters: [
      { dimension: 'destination', bound: 'exact', type: 'token', value: 'approved-archive' },
      { dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 50 },
    ],
  },
  requestedAt: '2026-01-01T00:00:00.000Z',
};

describe('CORE-03 — Kernel request validation of typed semantics', () => {
  it('accepts a well-formed classified request', () => {
    validateKernelEvaluationRequest(REQUEST);
  });

  it('refuses malformed semantics, parameters without semantics, and malformed parameter lists', () => {
    const cases: readonly KernelEvaluationRequest['action'][] = [
      { ...REQUEST.action, semantics: { ...SEMANTICS, actionClass: 'Export Class' } },
      { ...REQUEST.action, semantics: { ...SEMANTICS, governanceProfile: { ...SEMANTICS.governanceProfile, digest: 'not-a-digest' } } },
      { type: 'x', resourceScope: 'y', governedParameters: [{ dimension: 'recordCount', bound: 'maximum', type: 'integer', value: 1 }] },
      { ...REQUEST.action, governedParameters: [] },
      { ...REQUEST.action, governedParameters: [{ dimension: 'recordCount', bound: 'maximum', type: 'token', value: 'x' }] },
      { ...REQUEST.action, governedParameters: [{ dimension: 'b', bound: 'exact', type: 'integer', value: 1 }, { dimension: 'a', bound: 'exact', type: 'integer', value: 1 }] },
      { ...REQUEST.action, governedParameters: [{ dimension: 'a', bound: 'exact', type: 'integer', value: 1.5 }] },
    ];
    for (const action of cases) assertThrowsInstance(() => validateKernelEvaluationRequest({ ...REQUEST, action }), KernelValidationError);
  });
});

describe('CORE-03 — typed semantics reach policy as typed fields, never as trusted facts', () => {
  it('maps classes, the profile id and typed parameters into the policy input; metadata stays resolved-facts only', () => {
    const input = toGuardActionRequestInput(REQUEST, undefined);
    const policy = input.policyEvaluationInput;
    assert.ok(policy !== undefined);
    assert.equal(policy.actionClass, 'export');
    assert.equal(policy.resourceClass, 'customer_dataset');
    assert.equal(policy.governanceProfile, 'customer-data-export');
    assert.deepEqual(policy.governedParameters, [
      { dimension: 'destination', type: 'token', value: 'approved-archive' },
      { dimension: 'recordCount', type: 'integer', value: 50 },
    ]);
    assert.equal(policy.metadata, undefined, 'a proposed parameter is never written into the resolved-facts namespace');
  });

  it('a caller-asserted context key cannot become a policy parameter', () => {
    const smuggled = toGuardActionRequestInput({ ...REQUEST, context: { recordCount: 1000000, governedParameters: [{ dimension: "recordCount", type: "integer", value: 1 }] } }, undefined);
    assert.deepEqual(smuggled.policyEvaluationInput?.governedParameters?.find((parameter) => parameter.dimension === 'recordCount')?.value, 50);
  });
});

describe('CORE-03 — the grant source binds the profile and bounds every evaluated parameter', () => {
  const decision = { decisionId: 'dec-1', status: 'allowed', evaluatedAt: '2026-01-01T00:00:01.000Z' } as KernelEvaluationResult;

  it('projects the profile reference as an identity axis and each parameter under its declared bound kind', () => {
    const source = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), REQUEST, decision);
    assert.deepEqual(source.scope.governanceProfile, { kind: 'identity', value: `customer-data-export@2#${DIGEST}` });
    assert.deepEqual(source.scope.parameters, [
      { dimension: 'destination', kind: 'exact', type: 'token', value: 'approved-archive' },
      { dimension: 'recordCount', kind: 'maximum', type: 'integer', limit: 50 },
    ]);
    assert.equal(source.scope.amount, undefined, 'no money axis is invented for a non-financial action');
  });

  it('a parameter no declared bound can express projects an unusable source — never an unbounded dimension', () => {
    const request = { ...REQUEST, action: { ...REQUEST.action, governedParameters: [{ dimension: 'environment', bound: 'maximum', type: 'token', value: 'prod' }] } } as unknown as KernelEvaluationRequest;
    const source = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), request, decision);
    assert.deepEqual(source.scope.parameters, [], 'an empty list is not a well-formed scope, so no grant can derive from it');
  });

  it('a request without semantics projects exactly the pre-CORE-03 axes', () => {
    const { semantics: _s, governedParameters: _p, ...legacyAction } = REQUEST.action;
    const source = deriveGrantSourceAuthorization(new KernelGrantCapability({ declaration: {} }), { ...REQUEST, action: legacyAction }, decision);
    assert.deepEqual(Object.keys(source.scope).sort(), ['action', 'organization', 'resources']);
  });
});
