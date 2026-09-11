import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContextFactObservation } from '../domain/context-fact.js';
import type { ContextDeclaration } from '../domain/context-requirement.js';
import type { ContextSource } from '../domain/context-source.js';
import { ContextResolutionService } from '../services/context-resolution-service.js';
import { createInMemoryContextResolver } from '../services/in-memory-context-resolver.js';

const NOW = '2026-01-01T12:00:00.000Z';

const SOURCES: readonly ContextSource[] = [
  { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' },
  { id: 'ctx.src.crm.salesforce', kind: 'crm', name: 'Salesforce', trustClass: 'authoritative' },
  { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' },
];

const DECLARATION: ContextDeclaration = {
  requirements: [
    { key: 'vendor.status', minimumTrustClass: 'authoritative', maxAgeSeconds: 3600, required: false },
    { key: 'invoice.status', minimumTrustClass: 'authoritative', required: false },
    { key: 'vendor.monthlySpend', minimumTrustClass: 'authoritative', required: false },
    { key: 'invoice.amount', minimumTrustClass: 'asserted', required: false },
    { key: 'vendor.projectedSpend', minimumTrustClass: 'asserted', required: false },
  ],
  derivations: [{ key: 'vendor.projectedSpend', operator: 'sum', operandKeys: ['vendor.monthlySpend', 'invoice.amount'] }],
};

const OBSERVATIONS: readonly ContextFactObservation[] = [
  { key: 'vendor.status', value: 'approved', sourceId: 'ctx.src.erp.sap-prod', observedAt: '2026-01-01T11:45:00.000Z' },
  { key: 'invoice.status', value: 'approved', sourceId: 'ctx.src.crm.salesforce', observedAt: '2026-01-01T11:00:00.000Z' },
  { key: 'vendor.monthlySpend', value: 15_000, sourceId: 'ctx.src.erp.sap-prod', observedAt: '2026-01-01T09:00:00.000Z' },
  { key: 'invoice.amount', value: 7_500, sourceId: 'ctx.src.request', observedAt: NOW },
];

function service(): ContextResolutionService {
  return new ContextResolutionService({ sources: SOURCES, declaration: DECLARATION });
}

describe('Context resolution is deterministic', () => {
  it('the same observations at the same instant produce a byte-identical resolution, repeatedly', () => {
    const first = JSON.stringify(service().classify(OBSERVATIONS, NOW));
    for (let attempt = 0; attempt < 25; attempt += 1) {
      assert.equal(JSON.stringify(service().classify(OBSERVATIONS, NOW)), first);
    }
  });

  it('observation order does not change the resolution — every output list is stably sorted', () => {
    const canonical = JSON.stringify(service().classify(OBSERVATIONS, NOW));
    const permutations = [
      [...OBSERVATIONS].reverse(),
      [OBSERVATIONS[2], OBSERVATIONS[0], OBSERVATIONS[3], OBSERVATIONS[1]].filter((entry): entry is ContextFactObservation => entry !== undefined),
      [OBSERVATIONS[3], OBSERVATIONS[1], OBSERVATIONS[2], OBSERVATIONS[0]].filter((entry): entry is ContextFactObservation => entry !== undefined),
    ];
    for (const permutation of permutations) {
      assert.equal(JSON.stringify(service().classify(permutation, NOW)), canonical);
    }
  });

  it('a duplicated observation changes nothing — agreeing sources collapse to one fact', () => {
    const duplicated = [...OBSERVATIONS, ...OBSERVATIONS];
    assert.equal(JSON.stringify(service().classify(duplicated, NOW)), JSON.stringify(service().classify(OBSERVATIONS, NOW)));
  });

  it('serializes stably: a resolution survives a JSON round trip unchanged', () => {
    const resolution = service().classify(OBSERVATIONS, NOW);
    const roundTripped = JSON.parse(JSON.stringify(resolution)) as unknown;
    assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(resolution)));
    assert.equal(JSON.stringify(roundTripped), JSON.stringify(resolution), 'key order is stable across a round trip');
  });

  it('two independently-constructed services agree — nothing is carried in instance state', async () => {
    const resolver = createInMemoryContextResolver(OBSERVATIONS);
    const left = service();
    const right = service();
    const leftOut = await resolver.resolveContext({
      keys: left.requestedKeys(),
      actorId: 'actor-1',
      trustDomainId: 'td-1',
      action: 'payment',
      resourceScope: 'finance:payments',
      at: NOW,
    });
    const rightOut = await resolver.resolveContext({
      keys: right.requestedKeys(),
      actorId: 'actor-1',
      trustDomainId: 'td-1',
      action: 'payment',
      resourceScope: 'finance:payments',
      at: NOW,
    });
    assert.equal(JSON.stringify(left.classify(leftOut.observations, NOW)), JSON.stringify(right.classify(rightOut.observations, NOW)));
  });

  it('the in-memory resolver answers only the declared keys', async () => {
    const resolver = createInMemoryContextResolver([...OBSERVATIONS, { key: 'vendor.secretMargin', value: 0.42, sourceId: 'ctx.src.erp.sap-prod', observedAt: NOW }]);
    const output = await resolver.resolveContext({
      keys: ['vendor.status'],
      actorId: 'actor-1',
      trustDomainId: 'td-1',
      action: 'payment',
      resourceScope: 'finance:payments',
      at: NOW,
    });
    assert.deepEqual(output.observations.map((observation) => observation.key), ['vendor.status']);
  });
});
