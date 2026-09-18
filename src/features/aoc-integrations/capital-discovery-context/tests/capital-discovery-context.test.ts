import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ContextResolutionService, type ContextResolverPort } from '../../../context-resolution-runtime/index.js';
import { KernelContextCapability, resolveKernelContext } from '../../../../kernel/orchestration/context-adapter.js';
import { buildDraftClosureEmailGuardInput } from '../../../action-enforcement/fixtures/allowed-action.fixture.js';
import { toKernelRequest } from '../../../../kernel/__tests__/characterization/support.js';
import { CapitalDiscoveryContextProviderError, createCapitalDiscoveryContextProvider, type CapitalDiscoveryContextReadInput, type CapitalDiscoveryContextReading } from '../index.js';

const at = '2026-09-17T10:00:00Z';
const scope = 'capital-discovery-opportunity-projection:opaque_ABC-9';
const base = { keys: ['deployment.fact'], actorId: 'actor', trustDomainId: 'domain', action: 'capital.quote.submit', resourceScope: scope, at };

describe('Capital Discovery context provider', () => {
  it('satisfies the resolver port and projects only requested scalar observations', async () => {
    const calls: CapitalDiscoveryContextReadInput[] = [];
    const malicious = { key: 'deployment.fact', value: true, observedAt: at, maxAgeSeconds: 60,
      trustClass: 'authoritative', sourceId: 'forged', governanceDecision: 'ALLOW' };
    const provider: ContextResolverPort = createCapitalDiscoveryContextProvider({ sourceId: 'configured-source', reader: {
      async readContext(input) {
        calls.push(input);
        return [malicious, { key: 'extra.fact', value: true, observedAt: at },
          { key: 'deployment.fact', value: { arbitrary: true }, observedAt: at },
          { key: 'deployment.fact', value: Number.NaN, observedAt: at },
          { key: 'deployment.fact', value: false, observedAt: at, maxAgeSeconds: -1 }] as readonly CapitalDiscoveryContextReading[];
      },
    } });
    const query = { ...base, keys: ['deployment.fact', 'deployment.fact'], organizationId: 'org' };
    const expected = { observations: [{ key: 'deployment.fact', value: true, sourceId: 'configured-source', observedAt: at, maxAgeSeconds: 60 }] };
    assert.deepEqual(await provider.resolveContext(query), expected);
    assert.deepEqual(await provider.resolveContext(query), expected);
    assert.deepEqual(calls[0], { keys: ['deployment.fact'], action: 'capital.quote.submit',
      resource: { type: 'OpportunityProjectionRef', ref: 'opaque_ABC-9' }, actorId: 'actor',
      trustDomainId: 'domain', organizationId: 'org', at });
    assert.equal(Object.hasOwn(expected.observations[0]!, 'trustClass'), false);
  });

  it('rejects unrelated, malformed and mismatched scopes before invoking the reader', async () => {
    let calls = 0;
    const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
      async readContext() { calls++; return []; },
    } });
    for (const resourceScope of ['other:ref', 'capital-discovery-quote:', 'capital-discovery-quote:a:b',
      'capital-discovery-quote: ref', 'capital-discovery-quote:ref']) {
      assert.deepEqual(await provider.resolveContext({ ...base, resourceScope }), { observations: [] });
    }
    assert.deepEqual(await provider.resolveContext({ ...base, action: 'other.action' }), { observations: [] });
    assert.equal(calls, 0);
  });

  it('preserves each compatible resource identity and omits absent organization', async () => {
    const inputs: CapitalDiscoveryContextReadInput[] = [];
    const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
      async readContext(input) { inputs.push(input); return []; },
    } });
    for (const [action, kind, type] of [
      ['capital.opportunity.view', 'capital-discovery-opportunity-projection', 'OpportunityProjectionRef'],
      ['capital.quote.submit', 'capital-discovery-opportunity-projection', 'OpportunityProjectionRef'],
      ['capital.offer.accept', 'capital-discovery-quote', 'QuoteRef'],
      ['capital.quote.withdraw', 'capital-discovery-quote', 'QuoteRef'],
      ['capital.financing.execute', 'capital-discovery-financing-case', 'FinancingCaseRef'],
    ] as const) {
      await provider.resolveContext({ ...base, action, resourceScope: `${kind}:opaque_ABC-9` });
      assert.deepEqual(inputs.at(-1)?.resource, { type, ref: 'opaque_ABC-9' });
      assert.equal(Object.hasOwn(inputs.at(-1)!, 'organizationId'), false);
    }
    assert.equal(inputs.length, 5);
  });

  it('takes trust classification from the registry for identical provider output', async () => {
    const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
      async readContext() { return [{ key: 'deployment.fact', value: true, observedAt: at }]; },
    } });
    const observations = (await provider.resolveContext(base)).observations;
    const classify = (trustClass: 'asserted' | 'authoritative') => new ContextResolutionService({
      sources: [{ id: 'source', kind: 'internal_store', name: 'CD state', trustClass }],
      declaration: { requirements: [{ key: 'deployment.fact', minimumTrustClass: 'asserted', required: false }] },
    }).classify(observations, at);
    assert.equal(classify('asserted').facts[0]?.trustClass, 'asserted');
    assert.equal(classify('authoritative').facts[0]?.trustClass, 'authoritative');
    assert.equal(Object.hasOwn(observations[0]!, 'trustClass'), false);
  });

  it('accepts real calendar timestamps and numeric offsets without changing their text', async () => {
    for (const observedAt of ['2024-02-29T10:00:00Z', '2000-02-29T10:00:00Z',
      '2026-09-17T10:00:00Z', '2026-09-17T10:00:00.123Z',
      '2026-09-17T10:00:00-05:00', '2026-09-17T10:00:00+05:30']) {
      const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
        async readContext() { return [{ key: 'deployment.fact', value: true, observedAt }]; },
      } });
      assert.equal((await provider.resolveContext(base)).observations[0]?.observedAt, observedAt);
    }
  });

  it('omits impossible and malformed timestamps rather than substituting query time', async () => {
    for (const observedAt of ['2026-02-29T10:00:00Z', '2026-02-30T10:00:00Z',
      '1900-02-29T10:00:00Z', '2100-02-29T10:00:00Z', '2026-04-31T10:00:00Z',
      '2026-13-01T10:00:00Z', '2026-01-01T25:00:00Z', '2026-01-01T10:61:00Z',
      '2026-01-01T10:00:61Z', 'yesterday']) {
      const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
        async readContext() { return [{ key: 'deployment.fact', value: true, observedAt }]; },
      } });
      assert.deepEqual((await provider.resolveContext(base)).observations, []);
    }
  });

  it('rejects every pair of accepted readings for one key with a sanitized error', async () => {
    for (const [value, observedAt] of [[true, at], [true, '2026-09-17T10:01:00Z'],
      [false, at], [false, '2026-09-17T10:01:00Z']] as const) {
      const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
        async readContext() { return [{ key: 'deployment.fact', value: true, observedAt: at },
          { key: 'deployment.fact', value, observedAt }]; },
      } });
      await assert.rejects(provider.resolveContext(base), (error: unknown) =>
        error instanceof CapitalDiscoveryContextProviderError &&
        error.code === 'DUPLICATE_CONTEXT_READING' && error.message === error.code);
    }
  });

  it('does not count rejected rows as duplicates and validates max age', async () => {
    const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
      async readContext() { return [
        { key: 'deployment.fact', value: true, observedAt: at, maxAgeSeconds: 60 },
        { key: 'deployment.fact', value: {}, observedAt: at },
        { key: 'other.fact', value: false, observedAt: at },
        ...[0, -1, NaN, Infinity].map((maxAgeSeconds) =>
          ({ key: 'deployment.fact', value: false, observedAt: at, maxAgeSeconds })),
      ] as readonly CapitalDiscoveryContextReading[]; },
    } });
    assert.deepEqual((await provider.resolveContext(base)).observations,
      [{ key: 'deployment.fact', value: true, sourceId: 'source', observedAt: at, maxAgeSeconds: 60 }]);
  });

  it('treats a duplicate reader failure as unresolved through the Kernel context adapter', async () => {
    const provider = createCapitalDiscoveryContextProvider({ sourceId: 'source', reader: {
      async readContext() { return [{ key: 'deployment.fact', value: true, observedAt: at },
        { key: 'deployment.fact', value: false, observedAt: at }]; },
    } });
    const capability = new KernelContextCapability({ provider,
      sources: [{ id: 'source', kind: 'internal_store', name: 'CD state', trustClass: 'authoritative' }],
      declaration: { requirements: [{ key: 'deployment.fact', minimumTrustClass: 'asserted', required: false }] },
    });
    const request = { ...toKernelRequest(buildDraftClosureEmailGuardInput()),
      action: { type: 'capital.quote.submit', resourceScope: scope } };
    const resolution = await resolveKernelContext(capability, request, at);
    assert.equal(resolution?.resolved, false);
    assert.deepEqual(resolution?.unresolved, ['deployment.fact']);
    assert.deepEqual(resolution?.facts, []);
  });

  it('validates opaque configured source IDs at the host boundary', () => {
    const reader = { async readContext() { return []; } };
    for (const sourceId of ['', ' ', ' source', 'source ', 'source\u0000', 'source\u0085', 'x'.repeat(257)]) {
      assert.throws(() => createCapitalDiscoveryContextProvider({ sourceId, reader }));
    }
    for (const sourceId of ['source', 'ctx.source.capital-discovery', 'capital-discovery:primary', 'source_A-1']) {
      assert.doesNotThrow(() => createCapitalDiscoveryContextProvider({ sourceId, reader }));
    }
  });
});
