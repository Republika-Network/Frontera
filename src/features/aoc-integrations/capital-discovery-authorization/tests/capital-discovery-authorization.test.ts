import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPITAL_DISCOVERY_ACTION_RESOURCE,
  CAPITAL_DISCOVERY_RESOURCE_KINDS,
  CapitalDiscoveryAuthorizationError,
  buildCapitalDiscoveryKernelRequest,
  capitalDiscoveryResourceScope,
  toCapitalDiscoveryResourceRef,
} from '../index.js';

const REF = 'opaque-ref_without_uuid';
const base = {
  requestId: 'request-1', actorId: 'actor-1', trustDomainId: 'domain-1',
  action: 'capital.opportunity.view', resource: { type: 'OpportunityProjectionRef', ref: REF },
  requestedAt: '2026-09-17T10:00:00Z',
};

function fails(input: unknown, code: string): void {
  assert.throws(() => buildCapitalDiscoveryKernelRequest(input), (error: unknown) =>
    error instanceof CapitalDiscoveryAuthorizationError && error.code === code);
}

describe('Capital Discovery authorization boundary', () => {
  it('maps each frozen resource to its exact kind and scope without tenant or attributes', () => {
    for (const [type, kind] of Object.entries(CAPITAL_DISCOVERY_RESOURCE_KINDS)) {
      const resource = { type, ref: REF };
      assert.deepEqual(toCapitalDiscoveryResourceRef(resource), { kind, id: REF });
      assert.equal(capitalDiscoveryResourceScope(resource), `${kind}:${REF}`);
      assert.equal(toCapitalDiscoveryResourceRef(resource).tenantId, undefined);
      assert.equal(toCapitalDiscoveryResourceRef(resource).attributes, undefined);
    }
  });

  it('preserves opaque non-UUID refs while reserving the scope delimiter', () => {
    for (const ref of [REF, 'external_ABC-123', 'x.y_z-9']) {
      assert.equal(toCapitalDiscoveryResourceRef({ type: 'OpportunityProjectionRef', ref }).id, ref);
      assert.equal(buildCapitalDiscoveryKernelRequest({ ...base, resource: { ...base.resource, ref } }).action.resourceScope,
        `capital-discovery-opportunity-projection:${ref}`);
    }
    for (const ref of ['opaque:child', ':', 'ref:', ':a', 'a:b:c']) {
      fails({ ...base, resource: { ...base.resource, ref } }, 'INVALID_EXTERNAL_REF');
      assert.throws(() => toCapitalDiscoveryResourceRef({ ...base.resource, ref }), (error: unknown) =>
        error instanceof CapitalDiscoveryAuthorizationError && error.code === 'INVALID_EXTERNAL_REF');
    }
    const parent = 'capital-discovery-opportunity-projection:opaque';
    const formerlyConstructibleChild = `${parent}:child`;
    assert.equal(formerlyConstructibleChild.startsWith(`${parent}:`), true);
    fails({ ...base, resource: { ...base.resource, ref: 'opaque:child' } }, 'INVALID_EXTERNAL_REF');
  });

  it('accepts exactly the five frozen pairs and rejects every cross-product mismatch', () => {
    for (const [action, expectedType] of Object.entries(CAPITAL_DISCOVERY_ACTION_RESOURCE)) {
      for (const type of Object.keys(CAPITAL_DISCOVERY_RESOURCE_KINDS)) {
        const input = { ...base, action, resource: { type, ref: REF } };
        if (type === expectedType) {
          assert.equal(buildCapitalDiscoveryKernelRequest(input).action.type, action);
        } else {
          fails(input, 'ACTION_RESOURCE_MISMATCH');
        }
      }
    }
    fails({ ...base, action: 'capital.unknown' }, 'UNKNOWN_CAPITAL_DISCOVERY_ACTION');
    fails({ ...base, resource: { type: 'OtherRef', ref: REF } }, 'UNKNOWN_CAPITAL_DISCOVERY_RESOURCE_TYPE');
  });

  it('builds a deterministic canonical request with only identifier and action fields', () => {
    const input = { ...base, actorOrgRef: 'funder-1', principalActorId: 'human-1', correlationId: 'corr-1' };
    const expected = {
      requestId: 'request-1',
      actor: { id: 'actor-1', trustDomainId: 'domain-1', principalId: 'human-1' },
      action: { type: 'capital.opportunity.view', resourceScope: `capital-discovery-opportunity-projection:${REF}` },
      requestedAt: '2026-09-17T10:00:00Z',
      organization: { id: 'funder-1' }, correlationId: 'corr-1',
    };
    assert.deepEqual(buildCapitalDiscoveryKernelRequest(input), expected);
    assert.deepEqual(buildCapitalDiscoveryKernelRequest(input), buildCapitalDiscoveryKernelRequest(input));
    assert.equal(buildCapitalDiscoveryKernelRequest(base).organization, undefined);
    assert.equal(buildCapitalDiscoveryKernelRequest(base).context, undefined);
    assert.equal(buildCapitalDiscoveryKernelRequest(base).action.parameters, undefined);
    assert.equal(buildCapitalDiscoveryKernelRequest({ ...base, actorOrgRef: 'other' }).action.resourceScope, expected.action.resourceScope);
  });

  it('rejects malformed bounded identifiers and timestamps', () => {
    for (const ref of ['', ' ', ' ref', 'ref ', 'ref\u0000', 'ref\u0085', 'x'.repeat(513)]) {
      fails({ ...base, resource: { type: 'OpportunityProjectionRef', ref } }, 'INVALID_EXTERNAL_REF');
    }
    for (const [field, code] of [
      ['requestId', 'INVALID_REQUEST_ID'], ['actorId', 'INVALID_ACTOR_ID'],
      ['trustDomainId', 'INVALID_TRUST_DOMAIN_ID'], ['actorOrgRef', 'INVALID_ORGANIZATION_ID'],
      ['principalActorId', 'INVALID_PRINCIPAL_ACTOR_ID'], ['correlationId', 'INVALID_CORRELATION_ID'],
    ] as const) {
      fails({ ...base, [field]: ' bad' }, code);
      fails({ ...base, [field]: 'x'.repeat(257) }, code);
    }
    fails({ ...base, requestedAt: 'yesterday' }, 'INVALID_REQUESTED_AT');
  });

  it('validates real calendar dates and preserves valid timestamps with offsets', () => {
    for (const requestedAt of [
      '2024-02-29T10:00:00Z', '2028-02-29T10:00:00Z',
      '2026-09-17T10:00:00-05:00', '2026-09-17T10:00:00+05:30',
      '2026-09-17T10:00:00.123Z',
    ]) {
      assert.equal(buildCapitalDiscoveryKernelRequest({ ...base, requestedAt }).requestedAt, requestedAt);
    }
    for (const requestedAt of [
      '2026-02-29T10:00:00Z', '2026-02-30T10:00:00Z', '2026-04-31T10:00:00Z',
      '2026-13-01T10:00:00Z', '2026-01-01T25:00:00Z',
      '2026-01-01T10:61:00Z', '2026-01-01T10:00:61Z',
      '2026-09-17T10:00:00+24:00', '2026-09-17T10:00:00-05:60',
    ]) {
      fails({ ...base, requestedAt }, 'INVALID_REQUESTED_AT');
    }
  });

  it('rejects untyped attempts to smuggle marketplace facts or governance results', () => {
    for (const field of [
      'fundableAmount', 'outstandingBalance', 'mandateMatched', 'quoteState',
      'projectionCurrent', 'companyOwnsOpportunity', 'funderOwnsQuote',
      'debtorIdentity', 'priorCommitmentClear', 'trustedContext', 'resolvedContext',
      'contextFacts', 'governanceDecision', 'context', 'payload',
    ]) {
      fails({ ...base, [field]: true }, 'INVALID_INTENT');
    }
    fails({ ...base, resource: { ...base.resource, attributes: { quoteState: 'ACTIVE' } } }, 'INVALID_EXTERNAL_REF');
    fails({ ...base, resource: { ...base.resource, tenantId: 'funder-1' } }, 'INVALID_EXTERNAL_REF');
    fails(Object.create(null), 'INVALID_REQUEST_ID');
    const inherited = Object.create({ fundableAmount: 100 }) as Record<string, unknown>;
    Object.assign(inherited, base);
    const request = buildCapitalDiscoveryKernelRequest(inherited);
    assert.equal(Object.hasOwn(request, 'fundableAmount'), false);
    assert.equal(request.context, undefined);
  });
});
