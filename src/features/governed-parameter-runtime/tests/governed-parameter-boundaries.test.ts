import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the governed-parameter runtime is allowed to be, enforced
 * structurally: a pure primitive every layer — the grant runtime included —
 * may import precisely because it imports nothing, reads no clock, touches no
 * I/O and evaluates no code.
 */
const ROOT = 'src/features/governed-parameter-runtime';

function productionSources(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'tests') out.push(...productionSources(full));
    } else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Comments stripped: what is forbidden is a call or an import, not a word the prose explains. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

const SOURCES = productionSources(ROOT);

describe('governed-parameter runtime boundaries', () => {
  it('has production sources to measure', () => {
    assert.ok(SOURCES.length >= 5, `found ${SOURCES.length}`);
  });

  it('imports nothing outside itself — not even Node built-ins', () => {
    for (const file of SOURCES) {
      for (const match of codeOf(file).matchAll(/from\s+'([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.ok(specifier.startsWith('./'), `${file} imports '${specifier}'`);
      }
    }
  });

  it('reads no clock, no randomness, no I/O and evaluates no code', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(/, /Math\.random/, /\bfetch\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /parseFloat|parseInt|Number\s*\(/]) {
        assert.equal(pattern.test(code), false, `${file} must not contain ${String(pattern)}`);
      }
    }
  });

  it('names no domain, rail, payment or intelligence vocabulary: dimensions are declared, never built in', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      for (const pattern of [/\bxrpl?\b/i, /lightning/i, /kubernetes/i, /customer/i, /payment/i, /deploy/i, /recordCount/, /\bllm\b/i, /\bmodel\b/i, /riskScore/i, /\bagent\b/i]) {
        assert.equal(pattern.test(code), false, `${file} must stay domain-free (${String(pattern)})`);
      }
    }
  });
});
