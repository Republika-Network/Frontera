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

  it('50/51/52. the module reaches no execution, capability, payment, ASSURE, CORE-07 or identity code (B3B: only its composition root imports AUTH-03’s index)', () => {
    // FV-P4C-2B3B: exactly one file, the protected composition root, issues the AUTH-03 pair, so it alone
    // may import AUTH-03, through its public index and nothing else; and the exclusivity module alone may ask
    // whether it runs on the main thread (exclusive connections are refused in workers). Every other file keeps the rule.
    const EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
      [join(MODULE, 'protected-host-composition.ts')]: ['../human-identity/index.js'],
      [join(MODULE, 'executor-exclusivity.ts')]: ['node:worker_threads'],
      // FV-P4C-2B3C-1: the supervisor alone starts the dedicated executor process (it opens no file; see its structure test).
      [join(MODULE, 'dedicated-executor-supervisor.ts')]: ['node:child_process'],
      // FV-P4C-2B3C-2A1: the registration ceremony alone verifies a G-02A capability (verifier, ledger, CORE-02 key
      // registry), anchors a genesis at CORE-07 and creates the AUTH-03 store (its index, and its pure genesis-digest
      // leaf). It executes nothing and is reached by nothing in the Host (its own structure test).
      [join(MODULE, 'identity-registration.ts')]: [
        '../authority-authenticity/signature-verification.js',
        '../authority-state-freshness/index.js',
        '../execution-capability/index.js',
        '../execution-capability/reference/consumption-ledger.js',
        '../human-identity/chain.js',
        '../human-identity/index.js',
      ],
      // FV-P4C-2B3C-2A2A: the first-administrator ceremony, the same family's second step, verifies its own G-02A
      // capability, opens the registered store as its exclusive owner under CORE-07, and appends the first
      // administrator through AUTH-03's first-administrator module (not exported from its index). It executes
      // nothing and is reached by nothing in the Host (its own structure test).
      [join(MODULE, 'identity-registration-first-administrator.ts')]: [
        '../authority-authenticity/signature-verification.js',
        '../authority-state-freshness/index.js',
        '../execution-capability/index.js',
        '../execution-capability/reference/consumption-ledger.js',
        '../human-identity/chain.js',
        '../human-identity/first-administrator.js',
        '../human-identity/index.js',
      ],
      // FV-P4C-2B3C-2A2B: the operator-enrolment ceremony, the family's third step: it reads FV roles and has AUTH-03's
      // FV operator rows verify and append the enrolment (neither exported from AUTH-03's index); it executes nothing.
      [join(MODULE, 'identity-registration-operator.ts')]: [
        '../authority-state-freshness/index.js',
        '../human-identity/first-administrator.js',
        '../human-identity/fv-domain.js',
        '../human-identity/fv-operator.js',
        '../human-identity/index.js',
      ],
      // FV-P4C-2B3C-2A3A: the revocation ceremony, the family's fourth step: it reads FV roles and has AUTH-03's FV
      // revocation verify and append the revocation (neither exported from AUTH-03's index); it executes nothing.
      [join(MODULE, 'identity-registration-revocation.ts')]: [
        '../authority-state-freshness/index.js',
        '../human-identity/first-administrator.js',
        '../human-identity/fv-domain.js',
        '../human-identity/fv-operator.js',
        '../human-identity/fv-revocation.js',
        '../human-identity/index.js',
      ],
    };
    for (const file of walk(MODULE)) {
      for (const specifier of specifiers(file)) {
        const allowed = specifier.startsWith('./') || ['node:crypto', 'node:fs', 'node:path', 'better-sqlite3'].includes(specifier) || (EXCEPTIONS[file] ?? []).includes(specifier);
        assert.ok(allowed, `${relative(ROOT, file)} imports ${specifier}`);
      }
    }
  });

  it('the authorizer reads AUTH-03 only through its structural port, never by importing the identity service', () => {
    const text = readFileSync(join(MODULE, 'human-decision-authorizer.ts'), 'utf8');
    assert.equal(/from '[^']*human-identity|from '[^']*approval-authority|createHumanIdentityService/.test(text), false);
  });

  it('2B2B. the bootstrap-authority settlement and decision methods are reached by nothing in the Host: no route, gateway, composition or CORE-05 code', () => {
    const IDENTITY = join(SRC, 'human-identity');
    const BOOTSTRAP_API = /beginBootstrapAuthorityDecision|peekBootstrapAuthorityDecision|authorizeBootstrapAuthorityDecision|recordBootstrapAuthoritySettlement|unsettledBootstrapAuthorityDecisions|bootstrapAuthorityDecision\(/;
    const callers = walk(SRC)
      .filter((file) => !file.startsWith(MODULE) && !file.startsWith(IDENTITY) && !file.includes(`${join('src', 'enterprise', '__tests__')}`))
      .filter((file) => BOOTSTRAP_API.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    assert.deepEqual(callers, []);
    for (const file of walk(join(ROOT, 'src')).filter((f) => !f.includes('__tests__') && !f.startsWith(MODULE) && !f.startsWith(IDENTITY))) {
      assert.equal(BOOTSTRAP_API.test(readFileSync(file, 'utf8')), false, relative(ROOT, file));
    }
    // CORE-05's passkey channel and its reconciliation are unchanged by this domain: they never name it.
    assert.equal(/bootstrap/i.test(readFileSync(join(SRC, 'approval-authority', 'human-decision.ts'), 'utf8')), false);
  });

  it('2B2B. the new FV modules read AUTH-03, Kernel-Authority and the history only through structural ports', () => {
    for (const name of ['authority-permissions.ts', 'authority-settlement.ts', 'human-decision-authorizer.ts']) {
      const text = readFileSync(join(MODULE, name), 'utf8');
      assert.equal(/from '[^']*(human-identity|approval-authority|kernel-authority|operator-control|features)/.test(text), false, name);
    }
  });
});
