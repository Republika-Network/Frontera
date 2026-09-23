import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MonetaryConfigurationError, createFinancialActionClassifier } from '../index.js';

/**
 * What the monetary runtime is allowed to be, enforced structurally: a pure
 * primitive every layer may import precisely because it imports nothing, reads
 * no clock, touches no I/O, and never turns an amount into a number.
 */

const ROOT = 'src/features/monetary-runtime';

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const PRODUCTION_SOURCES = sourceFiles(ROOT);

/** Comments stripped: what is forbidden is a call or an import, not a word the prose explains. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('Monetary runtime boundaries (P9)', () => {
  it('has production sources to check', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 5, `found ${PRODUCTION_SOURCES.length}`);
  });

  it('imports nothing outside itself — not even Node built-ins', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.ok(specifier.startsWith('./'), `${file} imports '${specifier}'`);
      }
    }
  });

  it('never converts an amount through floating point, and never rounds', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/parseFloat\s*\(/, /parseInt\s*\(/, /Math\.(round|floor|ceil|trunc)\s*\(/, /toFixed\s*\(/, /toPrecision\s*\(/, /\bNumber\s*\(\s*(value|text|canonical|left|right|amount)/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('exports no conversion from a JavaScript number into monetary text (P9 closure)', async () => {
    const surface = await import('../index.js');
    for (const name of Object.keys(surface)) assert.equal(/FromNumber$/i.test(name), false, `${name} would reintroduce a number ingress`);
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      assert.equal(/\(\s*\w+\s*:\s*number\b/.test(text) && /export function \w*[Ff]romNumber/.test(text), false, file);
      assert.equal(/String\(\s*value\b/.test(text), false, `${file}: spelling a number is the precision path P9 removed`);
    }
  });

  it('reaches no clock, network, filesystem or process, and constructs no code', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(/, /\bfetch\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /Math\.random/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('holds no FX: no rate, conversion or exchange vocabulary in code', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\brate\b/i, /\bfx\b/i, /convert/i, /exchange/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });
});

describe('Financial action classification (P9) — the host’s answer about an action', () => {
  const classifier = createFinancialActionClassifier({ financialActions: ['invoice.pay', 'payment'] });

  it('classifies a configured action as financial and everything else as non-financial', () => {
    assert.equal(classifier.classify('invoice.pay'), 'financial');
    assert.equal(classifier.classify('payment'), 'financial');
    assert.equal(classifier.classify('draft.email'), 'non-financial');
    assert.deepEqual(classifier.financialActions, ['invoice.pay', 'payment']);
  });

  it('reads exactly the action string: near-miss spellings, objects and flags are non-financial', () => {
    for (const action of ['Invoice.pay', 'invoice.pay ', ' payment', 'payment\u0000', '', undefined, null, { action: 'payment' }, ['payment']]) {
      assert.equal(classifier.classify(action), 'non-financial', JSON.stringify(action));
    }
  });

  it('has no input through which a caller could state a class', () => {
    assert.equal(classifier.classify.length, 1, 'one argument: the action identifier');
    const forged = { toString: () => 'payment', financial: true } as unknown;
    assert.equal(classifier.classify(forged), 'non-financial', 'an object is not an action identifier, whatever it claims');
  });

  it('is frozen and does not retain the configuration array', () => {
    const configured = ['payment'];
    const built = createFinancialActionClassifier({ financialActions: configured });
    configured.push('refund');
    assert.equal(built.classify('refund'), 'non-financial');
    assert.ok(Object.isFrozen(built));
    assert.ok(Object.isFrozen(built.financialActions));
  });

  it('refuses malformed configuration at wiring time', () => {
    for (const financialActions of [['payment', ''], ['payment', ' refund'], [42], 'payment']) {
      assert.throws(() => createFinancialActionClassifier({ financialActions } as unknown as { financialActions: readonly string[] }), MonetaryConfigurationError, JSON.stringify(financialActions));
    }
  });
});
