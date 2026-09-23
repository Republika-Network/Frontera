import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MONETARY_DECIMAL_MAXIMUM_DIGITS,
  addCanonicalDecimals,
  canonicalDecimalFromJsonNumberLexeme,
  canonicalDecimalScale,
  canonicalizeDecimalText,
  compareCanonicalDecimals,
  isCanonicalDecimal,
} from '../index.js';

/**
 * P9 — the canonical decimal contract.
 *
 * Every expectation below is a string. Nothing here computes an expected value
 * with JavaScript arithmetic, because the point being proved is that the
 * implementation does not rely on it either.
 */

describe('P9 canonical decimals — the one spelling', () => {
  for (const [input, canonical] of [
    ['0', '0'],
    ['1', '1'],
    ['10', '10'],
    ['123.45', '123.45'],
    ['12.345678', '12.345678'],
    ['1.0', '1'],
    ['1.00', '1'],
    ['0.50', '0.5'],
    ['123.4500', '123.45'],
    ['0.000001', '0.000001'],
    ['0.000', '0'],
    ['9007199254740993', '9007199254740993'],
    ['123456789012345678901234567890.123456789', '123456789012345678901234567890.123456789'],
  ] as const) {
    it(`${JSON.stringify(input)} canonicalizes to ${JSON.stringify(canonical)}`, () => {
      assert.equal(canonicalizeDecimalText(input), canonical);
      assert.equal(isCanonicalDecimal(canonical), true);
    });
  }

  it('semantically equal spellings collapse to one canonical value — so they can never digest differently', () => {
    const spellings = ['1', '1.0', '1.00', '1.000000'];
    assert.deepEqual(new Set(spellings.map((spelling) => canonicalizeDecimalText(spelling))), new Set(['1']));
  });

  it('only canonical text is canonical: trailing zeros, leading zeros and a bare point are not', () => {
    for (const value of ['1.0', '01', '00', '1.', '.5', '0.50', '-0', '+1']) assert.equal(isCanonicalDecimal(value), false, value);
  });
});

describe('P9 canonical decimals — refused, never repaired', () => {
  for (const value of [
    ' 1.00 ',
    '1 ',
    ' 1',
    '+1',
    '-1',
    '-0',
    '01',
    '01.000',
    '00.5',
    '1e3',
    '1E-8',
    '1e+3',
    'NaN',
    'Infinity',
    '-Infinity',
    '1,000.00',
    '1.000,00',
    '1_000',
    'USD 10',
    '10 USD',
    '0x10',
    '',
    '.',
    '.5',
    '5.',
    '1..2',
    '١٢٣',
    '1 000',
  ]) {
    it(`${JSON.stringify(value)} is refused`, () => {
      assert.equal(canonicalizeDecimalText(value), undefined);
      assert.equal(isCanonicalDecimal(value), false);
    });
  }

  it('a JavaScript number is refused — its precision was decided by whoever parsed it', () => {
    for (const value of [0, 1, 0.1, 7500, 9007199254740993, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(canonicalizeDecimalText(value), undefined, String(value));
      assert.equal(isCanonicalDecimal(value), false, String(value));
    }
  });

  it('non-strings of every other kind are refused', () => {
    for (const value of [null, undefined, true, {}, [], ['1'], { value: '1' }, 1n]) assert.equal(canonicalizeDecimalText(value), undefined);
  });

  it('hostile lengths are refused before they are parsed', () => {
    assert.equal(canonicalizeDecimalText('1'.repeat(MONETARY_DECIMAL_MAXIMUM_DIGITS)), '1'.repeat(MONETARY_DECIMAL_MAXIMUM_DIGITS));
    assert.equal(canonicalizeDecimalText('1'.repeat(MONETARY_DECIMAL_MAXIMUM_DIGITS + 1)), undefined);
    assert.equal(canonicalizeDecimalText(`1.${'0'.repeat(10_000)}`), undefined);
  });
});

describe('P9 canonical decimals — exact comparison and addition (no IEEE-754)', () => {
  it('"0.1" + "0.2" is exactly "0.3"', () => {
    assert.equal(addCanonicalDecimals('0.1', '0.2'), '0.3');
    assert.equal(compareCanonicalDecimals(addCanonicalDecimals('0.1', '0.2'), '0.3'), 0);
  });

  it('integers beyond 2^53 stay distinct', () => {
    assert.equal(compareCanonicalDecimals('9007199254740993', '9007199254740992'), 1);
    assert.equal(compareCanonicalDecimals('9007199254740992', '9007199254740993'), -1);
    assert.equal(compareCanonicalDecimals('9007199254740991', '9007199254740991'), 0);
    assert.equal(addCanonicalDecimals('9007199254740992', '1'), '9007199254740993');
  });

  it('the smallest fractional difference is seen', () => {
    assert.equal(compareCanonicalDecimals('1.000001', '1'), 1);
    assert.equal(compareCanonicalDecimals('0.000001', '0'), 1);
    assert.equal(compareCanonicalDecimals('12.345678', '12.345679'), -1);
  });

  it('aligns scales exactly and produces canonical output', () => {
    assert.equal(addCanonicalDecimals('0.5', '0.5'), '1');
    assert.equal(addCanonicalDecimals('123.45', '0.55'), '124');
    assert.equal(addCanonicalDecimals('0', '0'), '0');
    assert.equal(addCanonicalDecimals('99999999999999999999.99', '0.01'), '100000000000000000000');
  });

  it('refuses a non-canonical operand rather than comparing it', () => {
    assert.throws(() => compareCanonicalDecimals('1.0', '1'), RangeError);
    assert.throws(() => addCanonicalDecimals('1e3', '1'), RangeError);
  });

  it('reports the stated scale of canonical text', () => {
    assert.equal(canonicalDecimalScale('12'), 0);
    assert.equal(canonicalDecimalScale('12.3'), 1);
    assert.equal(canonicalDecimalScale('0.000001'), 6);
  });
});

describe('P9 canonical decimals — a JSON number lexeme, as the client wrote it (never via `number`)', () => {
  for (const [lexeme, canonical] of [
    ['7500', '7500'],
    ['7500.00', '7500'],
    ['0.1', '0.1'],
    ['9007199254740993', '9007199254740993'],
    ['9007199254740993.010', '9007199254740993.01'],
    ['123456789012345678901234567890.123456789', '123456789012345678901234567890.123456789'],
    ['1e3', '1000'],
    ['1E3', '1000'],
    ['1.5e3', '1500'],
    ['1.5e+3', '1500'],
    ['15e-1', '1.5'],
    ['1e-7', '0.0000001'],
    ['0.000001e0', '0.000001'],
    ['0e5', '0'],
    ['-0', '0'],
    ['-0.0', '0'],
  ] as const) {
    it(`${JSON.stringify(lexeme)} is exactly ${JSON.stringify(canonical)}`, () => {
      assert.equal(canonicalDecimalFromJsonNumberLexeme(lexeme), canonical);
    });
  }

  it('the lexeme beyond 2^53 is exact where the parsed number is not', () => {
    const lexeme = '9007199254740993';
    assert.equal(String(JSON.parse(lexeme)), '9007199254740992', 'the hazard is real');
    assert.equal(canonicalDecimalFromJsonNumberLexeme(lexeme), '9007199254740993');
  });

  for (const lexeme of ['-1', '-0.01', '01', '1.', '.5', '+1', '1e', '1e99999', '1e+9999', 'NaN', 'Infinity', ' 1', '1 ', '0x10', '1_000', '', '"1"']) {
    it(`${JSON.stringify(lexeme)} is refused`, () => {
      assert.equal(canonicalDecimalFromJsonNumberLexeme(lexeme), undefined);
    });
  }

  it('refuses a JavaScript number outright — it is not a lexeme', () => {
    for (const value of [0, 1, 7500, 0.1, 9007199254740993]) assert.equal(canonicalDecimalFromJsonNumberLexeme(value), undefined);
  });
});
