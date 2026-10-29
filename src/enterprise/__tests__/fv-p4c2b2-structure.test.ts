import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// FV-P4C-2B2 — the sovereign status history and its bootstrap stay internal: nothing in the
// Host, its routes, its adapters, its payment rails or its execution paths reaches them, and they
// reach nothing of those. Composition is deliberately absent until the authority decisions are taken.

const ROOT = join(__dirname, '..', '..', '..', '..');
const SRC = join(ROOT, 'src', 'enterprise');
const MODULE = join(SRC, 'sovereign-status-history');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const specifiers = (file: string) => [...readFileSync(file, 'utf8').matchAll(/(?:from\s+|import\(\s*)'([^']+)'/g)].map((match) => match[1]!);

describe('FV-P4C-2B2 structure — internal, unreachable, not composed', () => {
  it('49. no Host source outside the module and its tests imports it: no route, handler, rail, adapter or composition', () => {
    const importers = walk(SRC)
      .filter((file) => !file.startsWith(MODULE) && !file.includes(`${join('src', 'enterprise', '__tests__')}`))
      .filter((file) => specifiers(file).some((specifier) => specifier.includes('sovereign-status-history')))
      .map((file) => relative(ROOT, file));
    assert.deepEqual(importers, []);
    assert.equal(/sovereign-status-history|coordinateStatusHistoryBootstrap/.test(readFileSync(join(SRC, 'composition', 'composition-root.ts'), 'utf8')), false);
  });

  it('50/51/52. the module reaches no execution, capability, payment, ASSURE, CORE-07 or identity code', () => {
    for (const file of walk(MODULE)) {
      for (const specifier of specifiers(file)) {
        const allowed = specifier.startsWith('./') || ['node:crypto', 'node:fs', 'node:path', 'better-sqlite3'].includes(specifier);
        assert.ok(allowed, `${relative(ROOT, file)} imports ${specifier}`);
      }
    }
  });

  it('the authorizer reads AUTH-03 only through its structural port, never by importing the identity service', () => {
    const text = readFileSync(join(MODULE, 'human-decision-authorizer.ts'), 'utf8');
    assert.equal(/from '[^']*human-identity|from '[^']*approval-authority|createHumanIdentityService/.test(text), false);
  });
});
