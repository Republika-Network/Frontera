import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { readContextFact, readContextFacts } from '../domain/context-fact-read.js';
import type { ContextFactObservation } from '../domain/context-fact.js';
import type { ContextAssertedFactPolicy, ContextDeclaration, ContextRequirement } from '../domain/context-requirement.js';
import { unresolvedContextResolution } from '../domain/context-resolution.js';
import type { ContextSource } from '../domain/context-source.js';
import { ContextResolutionService } from '../services/context-resolution-service.js';

const NOW = '2026-01-01T12:00:00.000Z';
const ERP: ContextSource = { id: 'ctx.src.erp.sap-prod', kind: 'erp', name: 'SAP production', trustClass: 'authoritative' };
const CRM: ContextSource = { id: 'ctx.src.crm.salesforce', kind: 'crm', name: 'Salesforce', trustClass: 'authoritative' };
const REQUEST: ContextSource = { id: 'ctx.src.request', kind: 'request', name: 'The requester', trustClass: 'asserted' };

function resolve(
  declaration: ContextDeclaration,
  observations: readonly ContextFactObservation[],
): ReturnType<ContextResolutionService['classify']> {
  return new ContextResolutionService({ sources: [ERP, CRM, REQUEST], declaration }).classify(observations, NOW);
}

const AUTHORITATIVE: ContextRequirement = { key: 'vendor.status', minimumTrustClass: 'authoritative', required: false };
const ASSERTABLE: ContextRequirement = { key: 'vendor.status', minimumTrustClass: 'asserted', required: false };

function observed(sourceId: string, observedAt = NOW): ContextFactObservation {
  return { key: 'vendor.status', value: 'approved', sourceId, observedAt };
}

describe('Reading a declared requirement out of a resolution', () => {
  it('an authoritative read of an authoritative fact is satisfied, and carries its provenance', () => {
    const read = readContextFact(resolve({ requirements: [AUTHORITATIVE] }, [observed(ERP.id)]), AUTHORITATIVE);
    assert.equal(read.status, 'satisfied');
    assert.equal(read.value, 'approved');
    assert.equal(read.sourceId, ERP.id);
    assert.equal(read.effectiveTrustClass, 'authoritative');
    assert.equal(read.assertedFactReported, undefined);
  });

  it('a key nothing answered reads unresolved — never a default value', () => {
    const read = readContextFact(resolve({ requirements: [AUTHORITATIVE] }, []), AUTHORITATIVE);
    assert.equal(read.status, 'unresolved');
    assert.equal(read.value, undefined);
  });

  it('a resolver that could not be consulted at all reads context_not_resolved, which is a different fact', () => {
    const read = readContextFact(unresolvedContextResolution({ declaredKeys: ['vendor.status'], resolvedAt: NOW }), AUTHORITATIVE);
    assert.equal(read.status, 'context_not_resolved');
  });

  it('a key that was never declared reads undeclared, not unresolved', () => {
    const read = readContextFact(resolve({ requirements: [AUTHORITATIVE] }, [observed(ERP.id)]), { ...AUTHORITATIVE, key: 'invoice.status' });
    assert.equal(read.status, 'undeclared');
  });

  it('a stale fact reads stale, and its value is withheld from the read', () => {
    const declaration: ContextDeclaration = { requirements: [{ ...AUTHORITATIVE, maxAgeSeconds: 60 }] };
    const read = readContextFact(resolve(declaration, [observed(ERP.id, '2026-01-01T10:00:00.000Z')]), declaration.requirements[0] as ContextRequirement);
    assert.equal(read.status, 'stale');
    assert.equal(read.value, undefined);
  });

  it('a conflicted key reads conflicted, and no side is offered up', () => {
    const resolution = resolve({ requirements: [AUTHORITATIVE] }, [
      { key: 'vendor.status', value: 'approved', sourceId: ERP.id, observedAt: NOW },
      { key: 'vendor.status', value: 'suspended', sourceId: CRM.id, observedAt: NOW },
    ]);
    const read = readContextFact(resolution, AUTHORITATIVE);
    assert.equal(read.status, 'conflicted');
    assert.equal(read.value, undefined);
  });

  it('an asserted fact never satisfies an authoritative requirement, under every posture', () => {
    for (const assertedFactPolicy of ['permit', 'report', 'require-declaration'] as const) {
      const resolution = resolve({ requirements: [AUTHORITATIVE], assertedFactPolicy, assertableKeys: ['vendor.status'] }, [observed(REQUEST.id)]);
      const read = readContextFact(resolution, AUTHORITATIVE);
      assert.equal(read.status, 'insufficient_trust', `posture '${assertedFactPolicy}' must not relax a declared minimum`);
      assert.equal(read.value, undefined);
    }
  });
});

describe('The asserted-fact migration posture', () => {
  function readUnder(assertedFactPolicy: ContextAssertedFactPolicy, assertableKeys?: readonly string[]) {
    const declaration: ContextDeclaration = {
      requirements: [ASSERTABLE],
      assertedFactPolicy,
      ...(assertableKeys !== undefined ? { assertableKeys } : {}),
    };
    return readContextFact(resolve(declaration, [observed(REQUEST.id)]), ASSERTABLE);
  }

  it('permit is today’s behaviour exactly: an asserted fact satisfies a requirement that asked for no more', () => {
    const read = readUnder('permit');
    assert.equal(read.status, 'satisfied');
    assert.equal(read.value, 'approved');
    assert.equal(read.assertedFactReported, undefined);
  });

  it('report still lets it decide, and names it — the migration is a list before it is an outage', () => {
    const read = readUnder('report');
    assert.equal(read.status, 'satisfied');
    assert.equal(read.assertedFactReported, true);
  });

  it('require-declaration refuses an asserted fact for a key the deployment never declared assertable', () => {
    const read = readUnder('require-declaration');
    assert.equal(read.status, 'asserted_not_declared');
    assert.equal(read.value, undefined);
  });

  it('require-declaration admits an asserted fact for a key the deployment did declare assertable', () => {
    const read = readUnder('require-declaration', ['vendor.status']);
    assert.equal(read.status, 'satisfied');
    assert.equal(read.value, 'approved');
  });

  it('the default posture, stated nowhere, is permit', () => {
    const resolution = resolve({ requirements: [ASSERTABLE] }, [observed(REQUEST.id)]);
    assert.equal(resolution.assertedFactPolicy, 'permit');
    assert.equal(readContextFact(resolution, ASSERTABLE).status, 'satisfied');
  });
});

describe('Reading is a comparison, not a verdict', () => {
  it('no read carries an allow, a deny, a narrowing or a severity', () => {
    const read = readContextFact(resolve({ requirements: [AUTHORITATIVE] }, [observed(ERP.id)]), AUTHORITATIVE);
    for (const forbidden of ['allow', 'allowed', 'deny', 'denied', 'decision', 'effect', 'severity', 'risk', 'narrow', 'satisfied']) {
      assert.equal(forbidden in read, false, `a context read must carry no '${forbidden}' field`);
    }
    assert.deepEqual(Object.keys(read).sort(), ['effectiveTrustClass', 'key', 'observedAt', 'sourceId', 'status', 'trustClass', 'value']);
  });

  it('reads every declared requirement in declaration order', () => {
    const declaration: ContextDeclaration = {
      requirements: [
        { key: 'vendor.status', minimumTrustClass: 'authoritative', required: false },
        { key: 'invoice.status', minimumTrustClass: 'authoritative', required: true },
      ],
    };
    const reads = readContextFacts(resolve(declaration, [observed(ERP.id)]), declaration.requirements);
    assert.deepEqual(reads.map((read) => [read.key, read.status]), [
      ['vendor.status', 'satisfied'],
      ['invoice.status', 'unresolved'],
    ]);
  });
});
