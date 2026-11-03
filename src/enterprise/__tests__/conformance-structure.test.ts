import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { RN_SV_FRAMEWORK_V0_1 } from '../assurance/frameworks/rn-sv-framework.js';
import { computeDigest } from '../governance-store/digest.js';

/**
 * RN-CONFORM-02 — static scope and isolation checks over the source tree:
 * no network, HTTP, XRPL or token code in the conformance module; no import
 * of it from anywhere but its own tests (so no Host composition, no public
 * API); no Assurance imports; no committed private keys; and the protected
 * Founding Assessment artifacts unchanged.
 */

const ROOT = process.cwd();
const MODULE = join(ROOT, 'src', 'enterprise', 'conformance');
const read = (path: string) => readFileSync(path, 'utf8');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'dist' ? [] : walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
const moduleFiles = walk(MODULE);
const conformanceTests = readdirSync(join(ROOT, 'src', 'enterprise', '__tests__')).filter((f) => f.startsWith('conformance-')).map((f) => join(ROOT, 'src', 'enterprise', '__tests__', f));
/** Static `… from '…';` lines and dynamic `import('…')`. Anchored to line ends so SQL text inside template strings is not mistaken for an import. */
const importsOf = (text: string) => [...text.matchAll(/\bfrom\s+'([^']+)';\s*$/gm), ...text.matchAll(/\bimport\s*\(\s*'([^']+)'\s*\)/g), ...text.matchAll(/^import\s+'([^']+)';\s*$/gm)].map((m) => m[1]!);
/** A specifier that resolves into src/enterprise/conformance/ (and not, e.g., payment-runtime/tests/conformance/). */
const intoModule = (fromFile: string, specifier: string) => specifier.startsWith('.') && join(fromFile, '..', specifier).startsWith(MODULE);

describe('RN-CONFORM-02 scope and isolation', () => {
  it('the module exists and imports only node:crypto/fs/path, better-sqlite3, itself and CORE-02 authority-authenticity', () => {
    assert.ok(moduleFiles.length >= 10);
    for (const file of moduleFiles) {
      for (const specifier of importsOf(read(file))) {
        const ok = ['node:crypto', 'node:fs', 'node:path', 'better-sqlite3'].includes(specifier) || specifier.startsWith('./') || specifier.startsWith('../authority-authenticity/');
        assert.ok(ok, `${relative(ROOT, file)} imports '${specifier}'`);
      }
    }
  });

  it('contains no HTTP, network, XRPL, blockchain or token code', () => {
    const forbidden = [/node:(?:http|https|http2|net|tls|dgram|dns)\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\bxrpl\b/i, /\bethers\b|\bweb3\b|\bviem\b/i, /\$SOBE|\bsobe\b/i, /tokenomic|staking|slashing|airdrop|validator[- ]yield|on-chain reward/i, /createServer|listen\s*\(/];
    for (const file of [...moduleFiles, ...conformanceTests.filter((f) => !f.endsWith('conformance-structure.test.ts'))]) {
      const text = read(file);
      for (const pattern of forbidden) assert.ok(!pattern.test(text), `${relative(ROOT, file)} matches ${pattern}`);
    }
  });

  it('is imported by nothing outside its own module and tests: no Host composition, no public export', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter((f) => !f.startsWith(MODULE) && !conformanceTests.includes(f))
      .filter((f) => importsOf(read(f)).some((s) => intoModule(f, s)));
    assert.deepEqual(offenders.map((f) => relative(ROOT, f)), []);
    const pkg = JSON.parse(read(join(ROOT, 'package.json'))) as { exports: Record<string, unknown> };
    assert.ok(!JSON.stringify(pkg.exports).includes('conformance/'));
  });

  it('never imports or writes Assurance persistence', () => {
    for (const file of moduleFiles) {
      const text = read(file);
      assert.ok(!importsOf(text).some((s) => s.includes('assurance')), relative(ROOT, file));
      assert.ok(!/assurance_|AssuranceStore|createSqliteAssuranceStore/.test(text), relative(ROOT, file));
    }
  });

  it('commits no private key material: every test key is derived from a public label at run time', () => {
    for (const file of [...moduleFiles, ...conformanceTests]) assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(read(file)), relative(ROOT, file));
  });

  it('leaves the frozen rn.sv@0.1.0 framework and the Founding Assessment NO-GO unchanged', () => {
    assert.equal(computeDigest(RN_SV_FRAMEWORK_V0_1), 'sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58');
    const goNoGo = read(join(ROOT, 'docs', 'commercial', 'founding-assessment', 'ASSURE_COMMERCIAL_GO_NO_GO.md'));
    assert.match(goNoGo, /FINAL COMMERCIAL DECISION: NO-GO/);
  });
});
