import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ParameterDimensionConfigurationError,
  compareGovernedParameterBound,
  createParameterDimensionRegistry,
  formatGovernanceProfileReference,
  governedParameterBoundAdmits,
  governedParameterBoundFor,
  isSemanticIdentifier,
  isWellFormedDeclaredGovernedParameters,
  isWellFormedGovernedActionSemantics,
  parseGovernedParameterValue,
  serializeGovernedParameterBound,
  type GovernedParameterBound,
} from '../index.js';

/**
 * CORE-03 — the typed parameter primitive, measured directly: the grammar,
 * the no-coercion ingress, the two-kind bound algebra and the closed dimension
 * registry. Everything above it (grants, the Kernel, policy, the envelope)
 * inherits these answers, so they are pinned here first.
 */

const DIGEST = `sha256:${'b'.repeat(64)}`;

describe('semantic identifiers — one name, one spelling', () => {
  it('accepts the domain-declared shapes CORE-03 needs', () => {
    for (const id of ['recordCount', 'customer_dataset', 'production_environment', 'customer-data-export', 'xrpl_asset', 'read', 'release.version', 'a1']) {
      assert.equal(isSemanticIdentifier(id), true, id);
    }
  });

  it('refuses whitespace, control characters, paths, separators at the edges, doubled separators, uppercase starts and over-long names', () => {
    for (const id of ['', ' read', 'read ', 'Read', '1read', 'read\u0000', 'a/b', '../a', 'a..b', 'a__b', 'a-', '_a', 'a:b', 'a b', 'a'.repeat(65), 'rëad']) {
      assert.equal(isSemanticIdentifier(id), false, JSON.stringify(id));
    }
    for (const value of [undefined, null, 1, {}, ['read']]) assert.equal(isSemanticIdentifier(value), false);
  });
});

describe('typed values — parsed by the declared type, never coerced', () => {
  it('integer: a safe JSON number only', () => {
    assert.deepEqual(parseGovernedParameterValue('integer', 5000), { valid: true, value: { type: 'integer', value: 5000 } });
    assert.deepEqual(parseGovernedParameterValue('integer', 0), { valid: true, value: { type: 'integer', value: 0 } });
    assert.equal(parseGovernedParameterValue('integer', '100').valid, false, '"100" is not 100');
    assert.equal(parseGovernedParameterValue('integer', 100.5).valid, false);
    assert.equal(parseGovernedParameterValue('integer', -0).valid, false, '-0 would give 0 two spellings');
    assert.equal(parseGovernedParameterValue('integer', Number.MAX_SAFE_INTEGER + 1).valid, false);
    assert.equal(parseGovernedParameterValue('integer', Number.NaN).valid, false);
    assert.equal(parseGovernedParameterValue('integer', Number.POSITIVE_INFINITY).valid, false);
    assert.equal(parseGovernedParameterValue('integer', true).valid, false);
    assert.equal(parseGovernedParameterValue('integer', null).valid, false, 'null is not absent and not zero');
  });

  it('token: the token grammar only', () => {
    assert.equal(parseGovernedParameterValue('token', 'approved-archive').valid, true);
    assert.equal(parseGovernedParameterValue('token', '1.4.2').valid, true);
    for (const raw of ['', ' x', 'x ', 'a/b', '..\\x', 'a b', 'x\n', 'x'.repeat(129), 5, true, null]) {
      assert.equal(parseGovernedParameterValue('token', raw).valid, false, JSON.stringify(raw));
    }
  });

  it('boolean: JSON true or false only — never 1, "true" or null', () => {
    assert.deepEqual(parseGovernedParameterValue('boolean', false), { valid: true, value: { type: 'boolean', value: false } });
    for (const raw of [1, 0, 'true', 'false', null, undefined]) assert.equal(parseGovernedParameterValue('boolean', raw).valid, false, String(raw));
  });
});

describe('the bound algebra — exact and maximum, total, fail-closed', () => {
  const max = (limit: number): GovernedParameterBound => ({ kind: 'maximum', type: 'integer', limit });

  it('maximum: a lower limit is narrower, a higher one broader, an equal one equal', () => {
    assert.equal(compareGovernedParameterBound(max(1000), max(100)), 'narrower');
    assert.equal(compareGovernedParameterBound(max(100), max(1000)), 'broader');
    assert.equal(compareGovernedParameterBound(max(100), max(100)), 'equal');
  });

  it('exact: the same value is equal and any other value is incomparable, never ranked', () => {
    assert.equal(compareGovernedParameterBound({ kind: 'exact', type: 'token', value: 'prod' }, { kind: 'exact', type: 'token', value: 'prod' }), 'equal');
    assert.equal(compareGovernedParameterBound({ kind: 'exact', type: 'token', value: 'prod' }, { kind: 'exact', type: 'token', value: 'staging' }), 'incomparable');
    assert.equal(compareGovernedParameterBound({ kind: 'exact', type: 'integer', value: 5 }, { kind: 'exact', type: 'integer', value: 4 }), 'incomparable', 'a smaller exact value is not a narrowing of an exact bound');
  });

  it('different kinds, different types and malformed bounds are incomparable', () => {
    assert.equal(compareGovernedParameterBound(max(100), { kind: 'exact', type: 'integer', value: 50 }), 'incomparable');
    assert.equal(compareGovernedParameterBound({ kind: 'exact', type: 'token', value: '5' }, { kind: 'exact', type: 'integer', value: 5 }), 'incomparable', 'a token "5" is never the integer 5');
    assert.equal(compareGovernedParameterBound(max(100), max(Number.NaN)), 'incomparable');
    assert.equal(compareGovernedParameterBound(max(100), { kind: 'maximum', type: 'token', limit: 5 } as unknown as GovernedParameterBound), 'incomparable');
    assert.equal(compareGovernedParameterBound(max(100), { kind: 'range', type: 'integer', limit: 5 } as unknown as GovernedParameterBound), 'incomparable');
  });

  it('admits: maximum admits at or below its limit; exact admits only its value; types must match', () => {
    assert.equal(governedParameterBoundAdmits(max(100), { type: 'integer', value: 100 }), true);
    assert.equal(governedParameterBoundAdmits(max(100), { type: 'integer', value: 101 }), false);
    assert.equal(governedParameterBoundAdmits(max(100), { type: 'token', value: '50' }), false);
    assert.equal(governedParameterBoundAdmits({ kind: 'exact', type: 'boolean', value: true }, { type: 'boolean', value: true }), true);
    assert.equal(governedParameterBoundAdmits({ kind: 'exact', type: 'boolean', value: true }, { type: 'boolean', value: false }), false);
  });

  it('projection: the declared kind decides, and a kind the type cannot support projects nothing', () => {
    assert.deepEqual(governedParameterBoundFor('maximum', { type: 'integer', value: 50 }), max(50));
    assert.deepEqual(governedParameterBoundFor('exact', { type: 'integer', value: 50 }), { kind: 'exact', type: 'integer', value: 50 });
    assert.equal(governedParameterBoundFor('maximum', { type: 'token', value: 'x' }), undefined);
  });

  it('serialization: canonical key order, one spelling per bound', () => {
    assert.equal(serializeGovernedParameterBound(max(1000)), '{"kind":"maximum","limit":1000,"type":"integer"}');
    assert.equal(serializeGovernedParameterBound({ kind: 'exact', type: 'token', value: 'prod' }), '{"kind":"exact","type":"token","value":"prod"}');
    assert.equal(serializeGovernedParameterBound({ kind: 'exact', type: 'boolean', value: false }), '{"kind":"exact","type":"boolean","value":false}');
  });
});

describe('the dimension registry — extensible for domains, closed for authority', () => {
  it('builds a frozen, sorted registry from valid declarations', () => {
    const registry = createParameterDimensionRegistry([
      { id: 'recordCount', type: 'integer', bound: 'maximum' },
      { id: 'destination', type: 'token', bound: 'exact' },
      { id: 'rollbackAvailable', type: 'boolean', bound: 'exact' },
    ]);
    assert.deepEqual(registry.dimensions.map((dimension) => dimension.id), ['destination', 'recordCount', 'rollbackAvailable']);
    assert.equal(Object.isFrozen(registry), true);
    assert.equal(registry.get('recordCount')?.bound, 'maximum');
    assert.equal(registry.get('RecordCount'), undefined, 'a differently-cased id is a different, undeclared name');
    assert.equal(registry.get('constructor'), undefined, 'no prototype member answers for a dimension');
    assert.equal(registry.get('__proto__'), undefined);
  });

  it('refuses duplicates — including case-only duplicates — unknown types, unknown bounds and unsupported comparators', () => {
    const refusals: unknown[] = [
      'not-an-array',
      [{ id: 'recordCount', type: 'integer', bound: 'maximum' }, { id: 'recordCount', type: 'integer', bound: 'exact' }],
      [{ id: 'recordCount', type: 'integer', bound: 'maximum' }, { id: 'RecordCount', type: 'integer', bound: 'maximum' }],
      [{ id: 'recordCount', type: 'float', bound: 'maximum' }],
      [{ id: 'recordCount', type: 'integer', bound: 'range' }],
      [{ id: 'environment', type: 'token', bound: 'maximum' }],
      [{ id: 'flag', type: 'boolean', bound: 'maximum' }],
      [{ id: 'Record', type: 'integer', bound: 'exact' }],
      [{ id: 'recordCount', type: 'integer', bound: 'maximum', comparator: 'x => x < 10' }],
      [{ id: 'recordCount', type: 'integer' }],
      [null],
      Array.from({ length: 65 }, (_, index) => ({ id: `d${index}`, type: 'integer', bound: 'exact' })),
    ];
    for (const declarations of refusals) {
      assert.throws(() => createParameterDimensionRegistry(declarations), ParameterDimensionConfigurationError, JSON.stringify(declarations).slice(0, 120));
    }
  });
});

describe('semantics and declared parameter lists', () => {
  const semantics = { actionClass: 'export', resourceClass: 'customer_dataset', governanceProfile: { id: 'customer-data-export', version: 1, digest: DIGEST } };

  it('a well-formed classification is accepted and formats to one reference', () => {
    assert.equal(isWellFormedGovernedActionSemantics(semantics), true);
    assert.equal(formatGovernanceProfileReference(semantics.governanceProfile), `customer-data-export@1#${DIGEST}`);
  });

  it('malformed classifications are refused', () => {
    for (const bad of [
      { ...semantics, actionClass: 'Export' },
      { ...semantics, resourceClass: '' },
      { ...semantics, governanceProfile: { ...semantics.governanceProfile, version: 0 } },
      { ...semantics, governanceProfile: { ...semantics.governanceProfile, version: 1.5 } },
      { ...semantics, governanceProfile: { ...semantics.governanceProfile, digest: 'sha256:xyz' } },
    ]) {
      assert.equal(isWellFormedGovernedActionSemantics(bad), false, JSON.stringify(bad));
    }
  });

  it('a declared parameter list must be sorted, duplicate-free, typed and supportable', () => {
    assert.equal(isWellFormedDeclaredGovernedParameters([{ dimension: 'destination', type: 'token', value: 'a', bound: 'exact' }, { dimension: 'recordCount', type: 'integer', value: 5, bound: 'maximum' }]), true);
    assert.equal(isWellFormedDeclaredGovernedParameters([]), false);
    assert.equal(isWellFormedDeclaredGovernedParameters([{ dimension: 'recordCount', type: 'integer', value: 5, bound: 'maximum' }, { dimension: 'destination', type: 'token', value: 'a', bound: 'exact' }]), false, 'unsorted');
    assert.equal(isWellFormedDeclaredGovernedParameters([{ dimension: 'a', type: 'integer', value: 5, bound: 'exact' }, { dimension: 'a', type: 'integer', value: 6, bound: 'exact' }]), false, 'duplicated: which one is real?');
    assert.equal(isWellFormedDeclaredGovernedParameters([{ dimension: 'a', type: 'token', value: 'x', bound: 'maximum' }]), false, 'maximum over a token');
    assert.equal(isWellFormedDeclaredGovernedParameters([{ dimension: 'a', type: 'integer', value: '5', bound: 'exact' } as never]), false, 'wrong value type');
  });
});
