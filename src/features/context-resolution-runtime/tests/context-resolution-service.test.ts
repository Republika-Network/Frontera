import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ContextFactObservation } from '../domain/context-fact.js';
import type { ContextDeclaration } from '../domain/context-requirement.js';
import { CONTEXT_DERIVED_SOURCE_ID, type ContextSource } from '../domain/context-source.js';
import { ContextResolutionService } from '../services/context-resolution-service.js';
import { ContextConfigurationError } from '../services/context-resolution-errors.js';

const NOW = '2026-01-01T12:00:00.000Z';

const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CRM: ContextSource = { id: 'ctx.src.crm.salesforce', kind: 'crm', name: 'Salesforce', trustClass: 'authoritative' };
const REQUEST: ContextSource = { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' };
const ATTESTOR: ContextSource = { id: 'ctx.src.attest.issuer', kind: 'signed_attestation', name: 'Issuer', trustClass: 'attested' };

const SOURCES = [ERP, CRM, REQUEST, ATTESTOR];

function service(declaration: ContextDeclaration, sources: readonly ContextSource[] = SOURCES): ContextResolutionService {
  return new ContextResolutionService({ sources, declaration });
}

function observation(overrides: Partial<ContextFactObservation> & Pick<ContextFactObservation, 'key' | 'value' | 'sourceId'>): ContextFactObservation {
  return { observedAt: NOW, ...overrides };
}

const VENDOR_STATUS: ContextDeclaration = {
  requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', required: false }],
};

describe('Context resolution — declared keys only', () => {
  it('asks for exactly the declared keys and nothing else', () => {
    const resolver = service({
      requirements: [
        { key: 'vendor.status', minimumTrustClass: 'authoritative', required: false },
        { key: 'invoice.status', minimumTrustClass: 'authoritative', required: false },
      ],
    });
    assert.deepEqual(resolver.requestedKeys(), ['invoice.status', 'vendor.status']);
  });

  it('discards observations for keys that were never declared — a resolver cannot widen the fact set', () => {
    const resolution = service(VENDOR_STATUS).classify(
      [
        observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id }),
        observation({ key: 'vendor.creditLimit', value: 999_999, sourceId: ERP.id }),
      ],
      NOW,
    );
    assert.deepEqual(resolution.facts.map((fact) => fact.key), ['vendor.status']);
    assert.deepEqual(resolution.declaredKeys, ['vendor.status']);
  });
});

describe('Context resolution — trust classification comes from configuration', () => {
  it('a fact takes the trust class of the source that answered, never one it named itself', () => {
    const resolution = service(VENDOR_STATUS).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id })], NOW);
    const fact = resolution.facts[0];
    assert.equal(fact?.trustClass, 'authoritative');
    assert.equal(fact?.effectiveTrustClass, 'authoritative');
    assert.equal(fact?.sourceKind, 'erp');
    assert.equal(fact?.resolution, 'resolved');
  });

  it('the same value from the request source is asserted, not authoritative', () => {
    const resolution = service(VENDOR_STATUS).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: REQUEST.id })], NOW);
    assert.equal(resolution.facts[0]?.trustClass, 'asserted');
  });

  it('an observation citing an unregistered source is discarded — the key resolves unresolved, never at a default class', () => {
    const resolution = service(VENDOR_STATUS).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: 'ctx.src.invented' })], NOW);
    assert.deepEqual(resolution.facts, []);
    assert.deepEqual(resolution.unresolved, ['vendor.status']);
    assert.equal(resolution.resolved, true, 'resolution completed; this key simply was not answered');
  });

  it('an attested source that produced no attestation reference cannot claim attestation', () => {
    const resolution = service({ requirements: [{ key: 'vendor.status', minimumTrustClass: 'attested', required: false }] }).classify(
      [observation({ key: 'vendor.status', value: 'approved', sourceId: ATTESTOR.id })],
      NOW,
    );
    assert.deepEqual(resolution.unresolved, ['vendor.status']);
  });

  it('an attested source with its attestation reference produces an attested fact', () => {
    const resolution = service({ requirements: [{ key: 'vendor.status', minimumTrustClass: 'attested', required: false }] }).classify(
      [observation({ key: 'vendor.status', value: 'approved', sourceId: ATTESTOR.id, attestationRef: 'att-1' })],
      NOW,
    );
    assert.equal(resolution.facts[0]?.trustClass, 'attested');
    assert.equal(resolution.facts[0]?.attestationRef, 'att-1');
  });

  it('an unparseable observation time is discarded rather than dated', () => {
    const resolution = service(VENDOR_STATUS).classify([{ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: 'whenever' }], NOW);
    assert.deepEqual(resolution.unresolved, ['vendor.status']);
  });
});

describe('Context resolution — freshness', () => {
  const FRESH: ContextDeclaration = { requirements: [{ key: 'vendor.status', minimumTrustClass: 'authoritative', maxAgeSeconds: 3600, required: false }] };

  it('a reading inside the declared window is resolved, and carries its staleAt', () => {
    const resolution = service(FRESH).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: '2026-01-01T11:30:00.000Z' })], NOW);
    assert.equal(resolution.facts[0]?.resolution, 'resolved');
    assert.equal(resolution.facts[0]?.freshness?.staleAt, '2026-01-01T12:30:00.000Z');
    assert.deepEqual(resolution.stale, []);
  });

  it('a reading past the declared window is stale — a distinct state, not an absence and not a value', () => {
    const resolution = service(FRESH).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: '2026-01-01T10:00:00.000Z' })], NOW);
    assert.equal(resolution.facts[0]?.resolution, 'stale');
    assert.deepEqual(resolution.stale, ['vendor.status']);
    assert.deepEqual(resolution.unresolved, [], 'stale is not unresolved');
    assert.equal(resolution.facts[0]?.value, 'approved', 'the stale value is still reported; what it means is the deployment’s to decide');
  });

  it('the stricter of the source’s bound and the requirement’s is what applies', () => {
    const resolution = service(FRESH).classify(
      [observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: '2026-01-01T11:50:00.000Z', maxAgeSeconds: 60 })],
      NOW,
    );
    assert.equal(resolution.facts[0]?.resolution, 'stale');
    assert.equal(resolution.facts[0]?.freshness?.maxAgeSeconds, 60);
  });

  it('a key with no declared freshness bound is never stale', () => {
    const resolution = service(VENDOR_STATUS).classify([observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: '1999-01-01T00:00:00.000Z' })], NOW);
    assert.equal(resolution.facts[0]?.resolution, 'resolved');
    assert.equal(resolution.facts[0]?.freshness, undefined);
  });
});

describe('Context resolution — conflict', () => {
  it('two sources that disagree produce a conflict, and neither side is chosen', () => {
    const resolution = service(VENDOR_STATUS).classify(
      [
        observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id }),
        observation({ key: 'vendor.status', value: 'suspended', sourceId: CRM.id }),
      ],
      NOW,
    );
    assert.deepEqual(resolution.conflicted, ['vendor.status']);
    assert.equal(resolution.facts.length, 2, 'both readings survive; a conflict is not reduced to a winner');
    assert.deepEqual(resolution.facts.map((fact) => fact.resolution), ['conflicted', 'conflicted']);
    // Stably ordered by source id, so the same disagreement always reads the same way.
    assert.deepEqual(resolution.facts.map((fact) => fact.sourceId), [CRM.id, ERP.id]);
    assert.deepEqual(resolution.facts.map((fact) => fact.value), ['suspended', 'approved']);
    assert.deepEqual(resolution.facts[0]?.conflictingSourceIds, [ERP.id]);
    assert.deepEqual(resolution.facts[1]?.conflictingSourceIds, [CRM.id]);
  });

  it('two sources that agree are not a conflict', () => {
    const resolution = service(VENDOR_STATUS).classify(
      [
        observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id }),
        observation({ key: 'vendor.status', value: 'approved', sourceId: CRM.id }),
      ],
      NOW,
    );
    assert.deepEqual(resolution.conflicted, []);
    assert.equal(resolution.facts.length, 1);
  });

  it('a higher-trust source wins among sources that agree — never among sources that disagree', () => {
    const resolution = service({ requirements: [{ key: 'vendor.status', minimumTrustClass: 'asserted', required: false }] }).classify(
      [
        observation({ key: 'vendor.status', value: 'approved', sourceId: REQUEST.id }),
        observation({ key: 'vendor.status', value: 'approved', sourceId: ERP.id }),
      ],
      NOW,
    );
    assert.equal(resolution.facts.length, 1);
    assert.equal(resolution.facts[0]?.sourceId, ERP.id);
    assert.equal(resolution.facts[0]?.trustClass, 'authoritative');
  });
});

describe('Context resolution — derived facts', () => {
  const SPEND: ContextDeclaration = {
    requirements: [
      { key: 'vendor.monthlySpend', minimumTrustClass: 'authoritative', required: false },
      { key: 'invoice.amount', minimumTrustClass: 'authoritative', required: false },
      { key: 'vendor.projectedSpend', minimumTrustClass: 'authoritative', required: false },
    ],
    derivations: [{ key: 'vendor.projectedSpend', operator: 'sum', operandKeys: ['vendor.monthlySpend', 'invoice.amount'] }],
  };

  it('a derived key is computed here, never asked of a resolver', () => {
    assert.deepEqual(service(SPEND).requestedKeys(), ['invoice.amount', 'vendor.monthlySpend']);
    assert.deepEqual(service(SPEND).declaredKeys(), ['invoice.amount', 'vendor.monthlySpend', 'vendor.projectedSpend']);
  });

  it('computes the aggregate and attributes it to Frontera’s own derived source', () => {
    const resolution = service(SPEND).classify(
      [
        observation({ key: 'vendor.monthlySpend', value: 15_000, sourceId: ERP.id }),
        observation({ key: 'invoice.amount', value: 7_500, sourceId: ERP.id }),
      ],
      NOW,
    );
    const derived = resolution.facts.find((fact) => fact.key === 'vendor.projectedSpend');
    assert.equal(derived?.value, 22_500);
    assert.equal(derived?.sourceId, CONTEXT_DERIVED_SOURCE_ID);
    assert.equal(derived?.trustClass, 'derived');
    assert.equal(derived?.effectiveTrustClass, 'authoritative');
    assert.deepEqual(derived?.derivation, { operator: 'sum', operandKeys: ['vendor.monthlySpend', 'invoice.amount'] });
  });

  it('one asserted operand makes the whole aggregate asserted — trust is never laundered by arithmetic', () => {
    const resolution = service({ ...SPEND, requirements: SPEND.requirements.map((r) => ({ ...r, minimumTrustClass: 'asserted' as const })) }).classify(
      [
        observation({ key: 'vendor.monthlySpend', value: 15_000, sourceId: ERP.id }),
        observation({ key: 'invoice.amount', value: 7_500, sourceId: REQUEST.id }),
      ],
      NOW,
    );
    const derived = resolution.facts.find((fact) => fact.key === 'vendor.projectedSpend');
    assert.equal(derived?.trustClass, 'derived');
    assert.equal(derived?.effectiveTrustClass, 'asserted');
  });

  it('a derivation over an operand that did not resolve is unresolved, never zero', () => {
    const resolution = service(SPEND).classify([observation({ key: 'vendor.monthlySpend', value: 15_000, sourceId: ERP.id })], NOW);
    assert.deepEqual(resolution.unresolved, ['invoice.amount', 'vendor.projectedSpend']);
    assert.equal(resolution.facts.find((fact) => fact.key === 'vendor.projectedSpend'), undefined);
  });

  it('a derivation over a stale operand is unresolved — staleness is not laundered either', () => {
    const declaration: ContextDeclaration = {
      ...SPEND,
      requirements: SPEND.requirements.map((requirement) => (requirement.key === 'invoice.amount' ? { ...requirement, maxAgeSeconds: 60 } : requirement)),
    };
    const resolution = service(declaration).classify(
      [
        observation({ key: 'vendor.monthlySpend', value: 15_000, sourceId: ERP.id }),
        observation({ key: 'invoice.amount', value: 7_500, sourceId: ERP.id, observedAt: '2026-01-01T10:00:00.000Z' }),
      ],
      NOW,
    );
    assert.deepEqual(resolution.stale, ['invoice.amount']);
    assert.deepEqual(resolution.unresolved, ['vendor.projectedSpend']);
  });

  it('a derived fact is dated from its oldest operand, never its freshest', () => {
    const resolution = service(SPEND).classify(
      [
        observation({ key: 'vendor.monthlySpend', value: 15_000, sourceId: ERP.id, observedAt: '2026-01-01T06:00:00.000Z' }),
        observation({ key: 'invoice.amount', value: 7_500, sourceId: ERP.id, observedAt: '2026-01-01T11:59:00.000Z' }),
      ],
      NOW,
    );
    assert.equal(resolution.facts.find((fact) => fact.key === 'vendor.projectedSpend')?.observedAt, '2026-01-01T06:00:00.000Z');
  });
});

describe('Context configuration is rejected at wiring time', () => {
  it('refuses a declaration whose derivation names an undeclared operand', () => {
    assert.throws(
      () =>
        service({
          requirements: [{ key: 'a', minimumTrustClass: 'authoritative', required: false }],
          derivations: [{ key: 'c', operator: 'sum', operandKeys: ['a', 'b'] }],
        }),
      ContextConfigurationError,
    );
  });

  it('refuses a duplicate requirement, and an assertable key that was never declared', () => {
    assert.throws(
      () =>
        service({
          requirements: [
            { key: 'a', minimumTrustClass: 'asserted', required: false },
            { key: 'a', minimumTrustClass: 'asserted', required: false },
          ],
        }),
      ContextConfigurationError,
    );
    assert.throws(
      () => service({ requirements: [{ key: 'a', minimumTrustClass: 'asserted', required: false }], assertableKeys: ['b'] }),
      ContextConfigurationError,
    );
  });

  it('refuses a configured source claiming the reserved derived-source id', () => {
    assert.throws(
      () => service(VENDOR_STATUS, [{ id: CONTEXT_DERIVED_SOURCE_ID, kind: 'erp', name: 'Impostor', trustClass: 'authoritative' }]),
      ContextConfigurationError,
    );
  });
});
