import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isCanonicalCustomerIdentifier } from '../../../enterprise/customer-identity/identifiers.js';
import {
  DESTINATION_IDENTIFIER_MAX_LENGTH,
  DESTINATION_KEY_MAX_LENGTH,
  EXECUTION_DESTINATION_VIOLATIONS as V,
  executionDestinationKey,
  isWellFormedExecutionDestination,
  parseExecutionDestination,
  sameExecutionDestination,
  type ExecutionDestination,
} from '../index.js';

/**
 * ANDREW-P0-01 — destination identity. Namespaces are synthetic on purpose:
 * this module is rail-neutral, and what it must prove holds for any namespace.
 */

function parsed(input: unknown): ExecutionDestination {
  const result = parseExecutionDestination(input);
  assert.equal(result.valid, true, JSON.stringify(result));
  if (!result.valid) throw new Error('unreachable');
  return result.destination;
}

function violation(input: unknown): string {
  const result = parseExecutionDestination(input);
  assert.equal(result.valid, false, `expected refusal of ${JSON.stringify(input)}`);
  return result.valid ? '' : result.violation;
}

describe('ExecutionDestination — creation', () => {
  it('a structurally valid destination is created, frozen, with exactly two fields', () => {
    const destination = parsed({ namespace: 'network-a', identifier: 'abc123' });
    assert.deepEqual(destination, { namespace: 'network-a', identifier: 'abc123' });
    assert.ok(Object.isFrozen(destination));
    assert.deepEqual(Object.keys(destination).sort(), ['identifier', 'namespace']);
  });

  it('the result is a copy — mutating the input afterwards changes nothing', () => {
    const input = { namespace: 'network-a', identifier: 'abc123' };
    const destination = parsed(input);
    input.identifier = 'other';
    assert.equal(destination.identifier, 'abc123');
  });

  it('a resource-URI identifier is representable without pretending to be a ledger address', () => {
    const destination = parsed({ namespace: 'provider-x', identifier: 'provider-x://destination/123' });
    assert.equal(executionDestinationKey(destination), 'provider-x:provider-x://destination/123');
  });

  it('a namespace may carry a network qualifier', () => {
    assert.ok(isWellFormedExecutionDestination(parsed({ namespace: 'network-a.testnet', identifier: 'abc123' })));
  });

  it('the identifier is held exactly at its maximum length, and refused one past it', () => {
    const max = 'a'.repeat(DESTINATION_IDENTIFIER_MAX_LENGTH);
    assert.equal(parsed({ namespace: 'network-a', identifier: max }).identifier, max);
    assert.equal(violation({ namespace: 'network-a', identifier: `${max}a` }), V.DESTINATION_IDENTIFIER_MALFORMED);
  });
});

describe('ExecutionDestination — structural refusal', () => {
  const identifierCases: readonly [string, unknown][] = [
    ['empty', ''],
    ['absent', undefined],
    ['a number', 123],
    ['null', null],
    ['an object', { value: 'abc' }],
    ['leading whitespace', ' abc123'],
    ['trailing whitespace', 'abc123 '],
    ['a trailing newline', 'abc123\n'],
    ['interior whitespace', 'abc 123'],
    ['a tab', 'abc\t123'],
    ['a NUL', 'abc\u0000123'],
    ['a C1 control', 'abc\u0085123'],
    ['a zero-width space', 'abc\u200b123'],
    ['a non-breaking space', 'abc\u00a0123'],
    ['a homoglyph (Cyrillic а)', '\u0430bc123'],
    ['a combining mark', 'abc\u0301123'],
    ['a bidi override', '\u202eabc123'],
    ['absurdly long', 'a'.repeat(100_000)],
  ];
  for (const [label, identifier] of identifierCases) {
    it(`refuses an identifier that is ${label}`, () => {
      assert.equal(violation({ namespace: 'network-a', identifier }), V.DESTINATION_IDENTIFIER_MALFORMED);
    });
  }

  const namespaceCases: readonly [string, unknown][] = [
    ['empty', ''],
    ['absent', undefined],
    ['a number', 1],
    ['uppercase-led', 'Network-a'],
    ['containing the key separator', 'network:a'],
    ['containing a slash', 'network/a'],
    ['containing whitespace', 'network a'],
    ['padded', ' network-a'],
    ['with a doubled separator', 'network--a'],
    ['non-ASCII', 'n\u00e9twork'],
    ['longer than 64', `n${'a'.repeat(64)}`],
  ];
  for (const [label, namespace] of namespaceCases) {
    it(`refuses a namespace that is ${label}`, () => {
      assert.equal(violation({ namespace, identifier: 'abc123' }), V.DESTINATION_NAMESPACE_MALFORMED);
    });
  }

  it('refuses anything but a plain record', () => {
    class Shaped {
      readonly namespace = 'network-a';
      readonly identifier = 'abc123';
    }
    for (const input of [null, undefined, 'network-a:abc123', 42, [], ['network-a', 'abc123'], new Shaped(), new Map()]) {
      assert.equal(violation(input), V.DESTINATION_NOT_A_RECORD, String(input));
    }
  });

  it('refuses an accessor — a getter could answer differently on a second read', () => {
    let reads = 0;
    const input = Object.defineProperty({ namespace: 'network-a' }, 'identifier', {
      enumerable: true,
      get: () => (reads++ === 0 ? 'abc123' : 'xyz789'),
    });
    assert.equal(violation(input), V.DESTINATION_NOT_A_RECORD);
  });

  it('accepts a null-prototype record', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, { namespace: 'network-a', identifier: 'abc123' });
    assert.equal(parsed(input).identifier, 'abc123');
  });

  it('refuses a symbol-keyed extra field', () => {
    assert.equal(violation({ namespace: 'network-a', identifier: 'abc123', [Symbol('approved')]: true }), V.DESTINATION_FIELD_UNEXPECTED);
  });
});

describe('ExecutionDestination — governance state cannot be self-asserted', () => {
  const governanceFields: readonly [string, unknown][] = [
    ['approved', true],
    ['approvedBy', 'operator-1'],
    ['approvedAt', '2026-01-01T00:00:00.000Z'],
    ['approvalStatus', 'approved'],
    ['status', 'approved'],
    ['revokedAt', '2026-01-01T00:00:00.000Z'],
    ['expiresAt', '2027-01-01T00:00:00.000Z'],
    ['known', true],
    ['trusted', true],
  ];
  for (const [field, value] of governanceFields) {
    it(`an input stating '${field}' is refused, not stripped`, () => {
      assert.equal(violation({ namespace: 'network-a', identifier: 'abc123', [field]: value }), V.DESTINATION_FIELD_UNEXPECTED);
    });
  }

  it('the destination type and every parsed value carry no approval field', () => {
    const destination = parsed({ namespace: 'network-a', identifier: 'abc123' }) as unknown as Record<string, unknown>;
    for (const field of governanceFields.map(([name]) => name)) assert.equal(field in destination, false, field);
  });

  it('a well-formed destination re-check never reads approval state — approval cannot make a malformed destination well formed', () => {
    assert.equal(isWellFormedExecutionDestination({ namespace: 'network-a', identifier: '', approved: true }), false);
  });

  it('extra state smuggled onto a value does not reach its canonical key', () => {
    const plain = { namespace: 'network-a', identifier: 'abc123' };
    const smuggled = { ...plain, approved: true, label: 'Treasury cold store' };
    assert.equal(executionDestinationKey(smuggled), executionDestinationKey(plain));
    assert.equal(executionDestinationKey(plain), 'network-a:abc123');
  });
});

describe('ExecutionDestination — display labels are not identity', () => {
  it('an input carrying a label or description is refused — a label is never part of a destination', () => {
    assert.equal(violation({ namespace: 'network-a', identifier: 'abc123', label: 'Vendor payout' }), V.DESTINATION_FIELD_UNEXPECTED);
    assert.equal(violation({ namespace: 'network-a', identifier: 'abc123', description: 'Vendor payout' }), V.DESTINATION_FIELD_UNEXPECTED);
  });

  it('two values that differ only by a label compare as the same destination, and two with the same label but different identifiers do not', () => {
    const a = { namespace: 'network-a', identifier: 'abc123', label: 'Vendor' } as ExecutionDestination;
    const b = { namespace: 'network-a', identifier: 'abc123', label: 'Something else' } as ExecutionDestination;
    const c = { namespace: 'network-a', identifier: 'xyz789', label: 'Vendor' } as ExecutionDestination;
    assert.equal(sameExecutionDestination(a, b), true);
    assert.equal(sameExecutionDestination(a, c), false);
  });
});

describe('ExecutionDestination — canonical identity', () => {
  it('identical semantic inputs produce identical keys, whatever the property order', () => {
    const left = parsed({ namespace: 'network-a', identifier: 'abc123' });
    const right = parsed({ identifier: 'abc123', namespace: 'network-a' });
    assert.equal(executionDestinationKey(left), executionDestinationKey(right));
    assert.equal(sameExecutionDestination(left, right), true);
  });

  it('the key is exactly <namespace>:<identifier> and is stable across calls', () => {
    const destination = parsed({ namespace: 'network-a', identifier: 'abc123' });
    const keys = new Set(Array.from({ length: 50 }, () => executionDestinationKey(destination)));
    assert.deepEqual([...keys], ['network-a:abc123']);
  });

  it('the same identifier under two namespaces is two destinations', () => {
    const a = parsed({ namespace: 'network-a', identifier: 'rABC123' });
    const b = parsed({ namespace: 'network-b', identifier: 'rABC123' });
    assert.notEqual(executionDestinationKey(a), executionDestinationKey(b));
    assert.equal(sameExecutionDestination(a, b), false);
  });

  it('a namespace that is a prefix of another does not collide', () => {
    const a = parsed({ namespace: 'network', identifier: 'a.x' });
    const b = parsed({ namespace: 'network.a', identifier: 'x' });
    assert.notEqual(executionDestinationKey(a), executionDestinationKey(b));
  });

  it('the separator cannot be forged from inside the identifier — the first ":" always ends the namespace', () => {
    const a = parsed({ namespace: 'network-a', identifier: 'b:abc' });
    assert.equal(violation({ namespace: 'network-a:b', identifier: 'abc' }), V.DESTINATION_NAMESPACE_MALFORMED);
    assert.equal(executionDestinationKey(a), 'network-a:b:abc');
  });

  it('materially different identifiers are different destinations', () => {
    const base = parsed({ namespace: 'network-a', identifier: 'abc123' });
    for (const identifier of ['abc124', 'abc1234', 'abc12', 'ABC123']) {
      const other = parsed({ namespace: 'network-a', identifier });
      assert.notEqual(executionDestinationKey(base), executionDestinationKey(other), identifier);
      assert.equal(sameExecutionDestination(base, other), false, identifier);
    }
  });

  it('case differences are preserved, never folded — normalization is the rail’s decision', () => {
    const upper = parsed({ namespace: 'network-a', identifier: '0xABCDEF' });
    const lower = parsed({ namespace: 'network-a', identifier: '0xabcdef' });
    assert.equal(upper.identifier, '0xABCDEF');
    assert.equal(lower.identifier, '0xabcdef');
    assert.equal(sameExecutionDestination(upper, lower), false);
  });

  it('a malformed destination has no key and is the same as nothing, itself included', () => {
    const bad = { namespace: 'network-a', identifier: ' abc' } as ExecutionDestination;
    assert.throws(() => executionDestinationKey(bad), TypeError);
    assert.equal(sameExecutionDestination(bad, bad), false);
    assert.equal(sameExecutionDestination(bad, parsed({ namespace: 'network-a', identifier: 'abc' })), false);
  });

  it('serializes deterministically: a parsed destination has one JSON spelling', () => {
    const left = parsed({ identifier: 'abc123', namespace: 'network-a' });
    const right = parsed({ namespace: 'network-a', identifier: 'abc123' });
    assert.equal(JSON.stringify(left), JSON.stringify(right));
    assert.equal(JSON.stringify(left), '{"namespace":"network-a","identifier":"abc123"}');
  });

  it('a parsed destination cannot be mutated after the fact', () => {
    const destination = parsed({ namespace: 'network-a', identifier: 'abc123' });
    assert.throws(() => {
      (destination as { identifier: string }).identifier = 'xyz789';
    }, TypeError);
    assert.equal(executionDestinationKey(destination), 'network-a:abc123');
  });
});

describe('ExecutionDestination — coexistence with the existing counterparty', () => {
  it('the longest possible key fits the bound the governed-action intent already applies to counterparty', () => {
    const longest = parsed({ namespace: `n${'a'.repeat(63)}`, identifier: '~'.repeat(DESTINATION_IDENTIFIER_MAX_LENGTH) });
    const key = executionDestinationKey(longest);
    assert.equal(key.length, DESTINATION_KEY_MAX_LENGTH);
    assert.equal(DESTINATION_KEY_MAX_LENGTH, 256);
    assert.equal(isCanonicalCustomerIdentifier(key), true);
  });

  it('every key is an admissible counterparty identifier — a later task can bind one without a format change', () => {
    for (const input of [
      { namespace: 'network-a', identifier: 'abc123' },
      { namespace: 'provider-x', identifier: 'provider-x://destination/123' },
      { namespace: 'network-b.testnet', identifier: '0xABCdef0123' },
    ]) {
      assert.equal(isCanonicalCustomerIdentifier(executionDestinationKey(parsed(input))), true, JSON.stringify(input));
    }
  });
});
