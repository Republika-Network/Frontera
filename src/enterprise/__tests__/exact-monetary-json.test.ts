import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GOVERNANCE_EVALUATE_AMOUNT_LOCATION, GOVERNED_ACTION_AMOUNT_LOCATION, parseJsonWithExactMonetaryNumber } from '../api/exact-monetary-json.js';

/**
 * P9 closure — the v1 wire's monetary JSON number is read from its exact source
 * text at the protocol boundary, and nothing else in the body changes.
 */

const governed = (text: string) => parseJsonWithExactMonetaryNumber(text, GOVERNED_ACTION_AMOUNT_LOCATION) as Record<string, Record<string, unknown>>;
const evaluate = (text: string) => parseJsonWithExactMonetaryNumber(text, GOVERNANCE_EVALUATE_AMOUNT_LOCATION) as Record<string, Record<string, unknown>>;

describe('P9 v1 wire — exact monetary JSON numbers', () => {
  it('the governed-action amount.value is its exact source text, canonicalized — beyond 2^53 included', () => {
    assert.equal(JSON.parse('9007199254740993'), 9007199254740992, 'the hazard is real');
    assert.equal(governed('{"amount":{"value":9007199254740993,"currency":"USD"}}')['amount']?.['value'], '9007199254740993');
    assert.equal(governed('{"amount":{"value":9007199254740993.010,"currency":"USD"}}')['amount']?.['value'], '9007199254740993.01');
    assert.equal(governed('{"amount":{"value":7.5e3,"currency":"USD"}}')['amount']?.['value'], '7500');
    assert.equal(governed('{"amount":{"value":0.30000000000000001,"currency":"USD"}}')['amount']?.['value'], '0.30000000000000001');
  });

  it('decimal text on the wire is left exactly as sent for the validator', () => {
    assert.equal(governed('{"amount":{"value":"10.50","currency":"USD"}}')['amount']?.['value'], '10.50');
  });

  it('a negative JSON number names no quantity and stays a number — which every monetary consumer refuses', () => {
    assert.equal(governed('{"amount":{"value":-5,"currency":"USD"}}')['amount']?.['value'], -5);
  });

  it('touches nothing but the one monetary location: other numbers, and look-alike keys elsewhere, keep their JSON type', () => {
    const parsed = governed('{"amount":{"value":1,"currency":"USD"},"assertedContext":{"amount":{"value":2},"n":3}}');
    assert.equal(parsed['amount']?.['value'], '1');
    const context = parsed['assertedContext'] as Record<string, Record<string, unknown> | number>;
    assert.equal((context['amount'] as Record<string, unknown>)['value'], 2);
    assert.equal(context['n'], 3);
  });

  it('the evaluate route’s action.amount is exact too', () => {
    assert.equal(evaluate('{"action":{"type":"payment","resourceScope":"s","amount":9007199254740993},"actor":{"id":"a","trustDomainId":"t"}}')['action']?.['amount'], '9007199254740993');
    assert.equal(evaluate('{"action":{"type":"payment","resourceScope":"s"},"amount":5}')['amount'] as unknown, 5, 'a top-level look-alike is not the monetary location');
  });

  it('malformed JSON still throws exactly as JSON.parse does, and a missing location is a no-op', () => {
    assert.throws(() => governed('{"amount":'), SyntaxError);
    assert.deepEqual(governed('{"action":"x"}'), { action: 'x' });
    assert.deepEqual(governed('[1,2]'), [1, 2]);
  });
});
