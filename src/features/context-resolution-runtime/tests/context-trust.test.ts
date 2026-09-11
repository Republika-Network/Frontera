import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_TRUST_CLASSES,
  TERMINAL_CONTEXT_TRUST_CLASSES,
  contextTrustClassSatisfies,
  isTerminalContextTrustClass,
  minimumContextTrustClass,
} from '../domain/context-trust.js';
import { validateContextSource, type ContextSource } from '../domain/context-source.js';

describe('Context trust classes', () => {
  it('names exactly the four classes the ADR declares, and three of them compare', () => {
    assert.deepEqual([...CONTEXT_TRUST_CLASSES].sort(), ['asserted', 'attested', 'authoritative', 'derived']);
    assert.deepEqual([...TERMINAL_CONTEXT_TRUST_CLASSES].sort(), ['asserted', 'attested', 'authoritative']);
    assert.equal(isTerminalContextTrustClass('derived'), false, 'derived always reduces before it is compared');
  });

  it('a requirement for authoritative is never satisfied by an asserted fact — the one unconditional guarantee', () => {
    assert.equal(contextTrustClassSatisfies('asserted', 'authoritative'), false);
    assert.equal(contextTrustClassSatisfies('asserted', 'attested'), false);
    assert.equal(contextTrustClassSatisfies('authoritative', 'attested'), false);
  });

  it('a fact at or above the declared minimum satisfies it', () => {
    assert.equal(contextTrustClassSatisfies('authoritative', 'authoritative'), true);
    assert.equal(contextTrustClassSatisfies('attested', 'authoritative'), true);
    assert.equal(contextTrustClassSatisfies('attested', 'attested'), true);
    assert.equal(contextTrustClassSatisfies('asserted', 'asserted'), true);
  });

  it('a derived class is the lowest of its operands — one asserted operand makes the whole aggregate asserted', () => {
    assert.equal(minimumContextTrustClass(['authoritative', 'asserted']), 'asserted');
    assert.equal(minimumContextTrustClass(['attested', 'authoritative']), 'authoritative');
    assert.equal(minimumContextTrustClass(['attested', 'attested']), 'attested');
  });

  it('a derivation with no operands reduces to the lowest class, never the highest', () => {
    assert.equal(minimumContextTrustClass([]), 'asserted');
  });
});

describe('Context sources are operator configuration, not requester input', () => {
  const source = (overrides: Partial<ContextSource>): ContextSource => ({
    id: 'ctx.src.erp.test',
    kind: 'erp',
    name: 'Test ERP',
    trustClass: 'authoritative',
    ...overrides,
  });

  it('accepts a well-formed source', () => {
    assert.deepEqual(validateContextSource(source({})), []);
  });

  it('refuses to let a deployment configure the requester as authoritative', () => {
    const violations = validateContextSource(source({ id: 'ctx.src.request', kind: 'request', trustClass: 'authoritative' }));
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? '', /may only be 'asserted'/);
  });

  it('a source of kind request is valid at asserted', () => {
    assert.deepEqual(validateContextSource(source({ id: 'ctx.src.request', kind: 'request', trustClass: 'asserted' })), []);
  });

  it('refuses attested on anything that is not a verified attestation', () => {
    const violations = validateContextSource(source({ trustClass: 'attested' }));
    assert.equal(violations.length, 1);
    assert.match(violations[0] ?? '', /requires kind 'signed_attestation'/);
  });

  it('rejects a source with no id, no name, or an unknown kind', () => {
    assert.ok(validateContextSource(source({ id: '' })).length > 0);
    assert.ok(validateContextSource(source({ name: '  ' })).length > 0);
    assert.ok(validateContextSource(source({ kind: 'telepathy' as ContextSource['kind'] })).length > 0);
  });
});
