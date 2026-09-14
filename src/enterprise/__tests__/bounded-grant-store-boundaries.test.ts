import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEnterprise } from '../composition/composition-root.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { KernelGrantCapability } from '../../kernel/orchestration/grant-adapter.js';
import { createRecordingExecutionAdapter } from '../../features/execution-runtime/tests/execution-fixture.js';
import { buildTestKernelProviders } from './support.js';

/**
 * The properties Prompt 4 added, pinned so a later change cannot quietly undo
 * them. Every rule below is measured against source or behaviour, never against
 * a line number, so refactoring the files is allowed and weakening them is not.
 */

const GRANT_STORE_ROOT = 'src/enterprise/bounded-grant-store';
const EXECUTION_RUNTIME_ROOT = 'src/features/execution-runtime';
const GRANT_RUNTIME_ROOT = 'src/features/grant-runtime';

function sourceFiles(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__')) continue;
      out.push(...sourceFiles(full, includeTests));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** A source file with its comments removed, so a rule measures what executes rather than what is explained. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');
}

const STORE_SOURCES = sourceFiles(GRANT_STORE_ROOT);
const EXECUTION_SOURCES = sourceFiles(EXECUTION_RUNTIME_ROOT);
const GRANT_SOURCES = sourceFiles(GRANT_RUNTIME_ROOT);

describe('Durable grant store — the rules below are not vacuous', () => {
  it('there are real production sources to measure in all three roots', () => {
    assert.ok(STORE_SOURCES.length >= 3, `expected sources under ${GRANT_STORE_ROOT}, found ${STORE_SOURCES.length}`);
    assert.ok(EXECUTION_SOURCES.length >= 5, `expected sources under ${EXECUTION_RUNTIME_ROOT}, found ${EXECUTION_SOURCES.length}`);
    assert.ok(GRANT_SOURCES.length >= 10, `expected sources under ${GRANT_RUNTIME_ROOT}, found ${GRANT_SOURCES.length}`);
  });

  it('the comment stripper keeps code and drops prose', () => {
    const store = codeOf(`${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`);
    assert.ok(store.includes('const runIssue = db.transaction('), 'real code must survive stripping');
    assert.equal(store.includes('Prompt 5 owns the key'), false, 'doc-comment prose must be stripped');
  });
});

describe('Durable grant store — storage stays behind the port', () => {
  it('the execution runtime never imports a storage implementation, a database driver or a filesystem', () => {
    const forbidden = [/better-sqlite3/, /bounded-grant-store/, /from ['"]node:fs['"]/, /from ['"][^'"]*\/enterprise\//];
    for (const file of EXECUTION_SOURCES) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not know how a grant is stored (${String(pattern)}) — it depends on the port and nothing else`);
      }
    }
  });

  it('the grant runtime stays free of persistence too — the port is declared there, never implemented against a database', () => {
    for (const file of GRANT_SOURCES) {
      const text = readFileSync(file, 'utf8');
      assert.equal(/better-sqlite3/.test(text), false, `${file} must not reach a database client`);
      assert.equal(/from ['"]node:fs['"]/.test(text), false, `${file} must not reach a filesystem`);
    }
  });

  it('the durable implementation is reachable only as a BoundedGrantStorePort', () => {
    const store = readFileSync(`${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`, 'utf8');
    assert.ok(/DurableBoundedGrantStore extends BoundedGrantStorePort/.test(store), 'the durable store must satisfy the port rather than declare a parallel contract');
  });
});

describe('Durable grant store — the exercise path cannot write, and cannot cache', () => {
  const EXECUTION_SERVICE = 'src/features/execution-runtime/services/grant-execution-service.ts';

  it('the execution service depends on the read-only port, so issue and revoke are not reachable from it', () => {
    const text = codeOf(EXECUTION_SERVICE);
    assert.ok(/readonly store: BoundedGrantReaderPort/.test(text), 'the exercise path must take the narrowed reader port');
    assert.equal(/BoundedGrantStorePort/.test(text), false, 'the full mutating port must not be what the exercise path is handed');
  });

  it('the narrowed port really is narrower — it declares read and nothing else', () => {
    const port = codeOf('src/features/grant-runtime/domain/grant-store-port.ts');
    const reader = /export interface BoundedGrantReaderPort \{([\s\S]*?)\n\}/.exec(port);
    assert.ok(reader?.[1] !== undefined, 'BoundedGrantReaderPort must remain a declared interface');
    const body = reader[1];
    assert.ok(body.includes('read('), 'it must still declare the authoritative read');
    assert.equal(body.includes('issue('), false, 'it must not declare issuance');
    assert.equal(body.includes('revoke('), false, 'it must not declare revocation');
  });

  it('the store is re-read on every attempt: no module-level grant or revocation is held anywhere in the exercise path', () => {
    for (const file of EXECUTION_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/new\s+Map\s*\(/, /new\s+WeakMap\s*\(/, /\bcache\b/i, /\bmemo(?:ize|ised|ized)?\b/i]) {
        assert.equal(pattern.test(text), false, `${file} must hold no cached grant state (${String(pattern)}) — a revocation committed a millisecond ago must be visible to the very next exercise`);
      }
    }
  });

  it('no background job becomes part of correctness, in the store or on the path', () => {
    const forbidden = [/setTimeout\s*\(/, /setInterval\s*\(/, /\bcron\b/i, /\bsweep/i, /setImmediate\s*\(/];
    for (const file of [...EXECUTION_SOURCES, ...STORE_SOURCES, ...GRANT_SOURCES]) {
      const text = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(text), false, `${file} must not depend on a background job (${String(pattern)}) — stopping every job in the deployment must change no answer`);
      }
    }
  });
});

describe('Durable grant store — integrity is verified, and revocation is first class', () => {
  const STORE = `${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`;

  it('every authoritative read runs through the verification helpers', () => {
    const text = codeOf(STORE);
    const read = /const runRead = db\.transaction\(([\s\S]*?)\n  \}\);/.exec(text);
    assert.ok(read?.[1] !== undefined, 'the authoritative read must remain one transaction');
    assert.ok(read[1].includes('verifiedGrant('), 'a grant must be verified before it is returned');
    assert.ok(read[1].includes('currentRevocation('), 'the revocation state must be resolved and cross-checked on the same read');
  });

  it('both record kinds are integrity-protected — a revocation is authority state, not audit metadata', () => {
    const text = codeOf(STORE);
    assert.ok(text.includes('storedGrantRecordDigest('), 'grants carry a record digest');
    assert.ok(text.includes('storedRevocationRecordDigest('), 'revocations carry one of comparable strength');
    assert.ok(/revocation_digest TEXT NOT NULL/.test(text), 'the revocation row must not be able to exist without its digest');
  });

  it('the grant’s own digest is checked as well as the record envelope’s', () => {
    assert.ok(codeOf(STORE).includes('boundedGrantDigestMatches('), 'the artifact digest and the record digest detect different substitutions');
  });

  it('every failed validation raises rather than returning something usable — no silent repair', () => {
    const text = codeOf(STORE);
    assert.ok(/function corrupt\(/.test(text), 'there must be one place a corruption refusal is constructed');
    for (const repairing of [/grant_json\s*=\s*@/, /UPDATE bounded_grant_revocations SET/, /DELETE FROM bounded_grant/]) {
      assert.equal(repairing.test(text), false, `the store must never rewrite or delete authority state (${String(repairing)})`);
    }
  });

  it('the grant row is written once and never rewritten except to link its revocation', () => {
    const text = codeOf(STORE);
    const updates = [...text.matchAll(/UPDATE bounded_grants SET ([a-z_]+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(updates)], ['revocation_digest'], 'the only mutable column on a grant row is the reference to its revocation');
  });

  it('the durable schema invents no consumption model (NB-006 stays open, and stays honest)', () => {
    const text = codeOf(STORE);
    for (const pattern of [/remainingUses/i, /use_count/i, /\buseCount\b/i, /\bsingleUse\b/i, /\bconsume/i, /\bdecrement/i, /quota/i]) {
      assert.equal(pattern.test(text), false, `the store must invent no consumption model (${String(pattern)}) — repeated exercise is currently permitted and durability does not change that`);
    }
  });
});

describe('Durable grant store — the commit guard stays synchronous', () => {
  it('the port still forbids an async guard', () => {
    const port = codeOf('src/features/grant-runtime/domain/grant-store-port.ts');
    assert.ok(/readonly commitGuard: \(\) => GrantCommitPrecondition;/.test(port), 'a guard returning a promise would reintroduce the interleaving the commit boundary exists to prevent');
  });

  it('the durable store calls the guard inside its transaction, with no await between the read that decides and the write that records', () => {
    const text = codeOf(`${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`);
    const issue = /const runIssue = db\.transaction\(([\s\S]*?)\n  \}\);/.exec(text);
    assert.ok(issue?.[1] !== undefined, 'issuance must remain one transaction');
    assert.ok(issue[1].includes('input.commitGuard()'), 'the guard must be called inside the transaction');
    assert.equal(/\bawait\b/.test(issue[1]), false, 'no await may appear inside the critical section');
    const guardAt = issue[1].indexOf('input.commitGuard()');
    const insertAt = issue[1].indexOf('insertGrant.run(');
    assert.ok(guardAt !== -1 && insertAt !== -1 && guardAt < insertAt, 'the guard must run before the write, in the same section');
  });
});

describe('Durable grant store — composition selects it exactly as every other store is selected', () => {
  it('a memory-persistence Host keeps the in-memory store, so nothing changes for a deployment that never asked for persistence', async () => {
    const enterprise = await createEnterprise({
      kernelProviders: buildTestKernelProviders(),
      authorityControlledExecution: {
        grantCapability: new KernelGrantCapability({ declaration: {} }),
        executionAdapter: createRecordingExecutionAdapter(),
        resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
      },
    });
    assert.ok(enterprise.authorityControlledExecution !== undefined);
    assert.equal(enterprise.configuration.persistence.provider, 'memory', 'the default persistence provider is unchanged by this phase');
    await enterprise.close();
  });

  it('the durable path is named by configuration rather than hardcoded, and is its own file', () => {
    const configuration = loadEnterpriseConfiguration({});
    assert.equal(configuration.boundedGrant.sqlitePath, '.data/bounded-grants.sqlite');
    for (const other of [configuration.persistence.sqlitePath, configuration.passport.sqlitePath, configuration.kernelAuthority.sqlitePath, configuration.assurance.sqlitePath]) {
      assert.notEqual(configuration.boundedGrant.sqlitePath, other, 'the authority store never shares a file with another store');
    }
    assert.equal(loadEnterpriseConfiguration({ AOC_ENTERPRISE_BOUNDED_GRANT_SQLITE_PATH: '/srv/grants.sqlite' }).boundedGrant.sqlitePath, '/srv/grants.sqlite');
  });

  it('the composition root, not the execution layer, is what knows about SQLite', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.ok(root.includes('createSqliteBoundedGrantStore('), 'store selection belongs at the composition boundary');
    const governance = sourceFiles('src/enterprise/execution-governance');
    for (const file of governance) {
      assert.equal(/better-sqlite3|createSqliteBoundedGrantStore/.test(codeOf(file)), false, `${file} must stay storage-agnostic`);
    }
  });
});
