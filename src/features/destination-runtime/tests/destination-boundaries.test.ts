import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the destination runtime is allowed to be, enforced structurally: a
 * pure, rail-neutral identity primitive that holds no governance state and
 * names no rail.
 */

const ROOT = 'src/features/destination-runtime';

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

/** Comments stripped: what is forbidden is code, not a word the prose explains. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

describe('Destination runtime boundaries (ANDREW-P0-01)', () => {
  it('has production sources to check', () => {
    assert.ok(PRODUCTION_SOURCES.length >= 3, `found ${PRODUCTION_SOURCES.length}`);
  });

  it('imports nothing but itself and the semantic-identifier grammar — not even Node built-ins', () => {
    for (const file of PRODUCTION_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)) {
        const specifier = match[1] ?? '';
        assert.ok(specifier.startsWith('./') || specifier === '../../governed-parameter-runtime/index.js', `${file} imports '${specifier}'`);
      }
    }
  });

  it('reaches no clock, randomness, network, filesystem or process, and constructs no code', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(/, /Math\.random/, /randomUUID/, /\bfetch\s*\(/, /\brequire\s*\(/, /\bimport\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bprocess\./]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('names no rail, ledger, wallet or provider in code', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bxrpl?\b/i, /\bwallet\b/i, /\bledger\b/i, /ethereum|\bevm\b/i, /lightning|bolt11/i, /\blumx\b/i, /stripe/i, /\biban\b/i, /signTransaction/, /private[_-]?key/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('holds no governance state — no approval, revocation, expiry or label vocabulary in code', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file).replace(/\/\*\*[^\n]*\*\//g, ' ');
      for (const pattern of [/\bapproved\w*\b/i, /\bapproval\w*\b/i, /\brevoked?\w*\b/i, /\bexpir\w*\b/i, /\blabel\b/i, /\bstatus\b/i, /\bregistry\b/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('normalizes nothing — no trim, case fold or Unicode normalization of an identifier', () => {
    for (const file of PRODUCTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\.trim\w*\s*\(/, /\.to(Lower|Upper)Case\s*\(/, /\.toLocale(Lower|Upper)Case\s*\(/, /\.normalize\s*\(/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('the public surface exports no approval, registry or mutation entry point', async () => {
    const surface = await import('../index.js');
    for (const name of Object.keys(surface)) assert.equal(/approv|revok|expir|regist|label|status/i.test(name), false, name);
  });
});
