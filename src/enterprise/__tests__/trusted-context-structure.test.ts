import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CORE-04 — structural invariants, read from the TypeScript sources.
 *
 * - CORE stays independent of INTEL (invariant 32): the Trusted Context
 *   Boundary, the obligation discharge store and the governed-trust
 *   composition name no model, provider, prompt or inference dependency, and
 *   perform no network I/O of their own.
 * - Authority to attest never becomes authority to authorize: the grant's
 *   source *scope* is projected from the request and the Kernel's own decision,
 *   never from context — context contributes only a digest and a validity
 *   ceiling, both of which can only narrow.
 * - Obligation discharge has exactly one writer surface, in-process: no HTTP
 *   adapter, no CTRL-01 administration code and no customer route reaches it.
 */

function codeOf(file: string): string {
  // Strip line and block comments so documentation that *names* a forbidden
  // thing (to forbid it) is not mistaken for a dependency on it.
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'tests' || name === '__tests__') continue;
      out.push(...walk(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const CORE04_SOURCES = [
  ...walk('src/features/context-resolution-runtime'),
  ...walk('src/features/obligation-runtime'),
  ...walk('src/enterprise/trusted-context'),
  ...walk('src/enterprise/obligation-discharge'),
  'src/enterprise/kernel-authority/authority-lineage-revalidator.ts',
  'src/kernel/orchestration/context-adapter.ts',
  'src/kernel/orchestration/obligation-adapter.ts',
];

describe('CORE-04 structure — CORE is independent of INTEL', () => {
  it('has real sources to measure', () => {
    assert.ok(CORE04_SOURCES.length >= 30, `found ${CORE04_SOURCES.length}`);
  });

  it('names no model, provider, prompt, embedding, inference or agent-framework dependency', () => {
    const forbidden = [/\banthropic\b/i, /\bopenai\b/i, /\bllm\b/i, /\binference\b/i, /\bembedding/i, /\bprompt\b/i, /\brisk[Ss]core/, /\banomal/i, /\brecommend/i, /\bintel\b/i, /\bintelligence\b/i, /\bvector\b/i, /from ['"][^'"]*(langchain|@anthropic-ai|openai)/];
    for (const file of CORE04_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file} must not depend on intelligence (${String(pattern)})`);
    }
  });

  it('performs no network I/O and loads no ERP, CRM, chain or live-data SDK — retrieval is a port, admission is local', () => {
    const forbidden = [/from ['"]node:http/, /from ['"]node:https/, /from ['"]node:net['"]/, /\bfetch\s*\(/, /from ['"][^'"]*(sap|salesforce|xrpl|ldr|live-data)/i];
    for (const file of CORE04_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${file} must perform no network I/O (${String(pattern)})`);
    }
  });
});

describe('CORE-04 structure — context never shapes a grant’s authority', () => {
  it('the source scope projection reads the request, never context or obligations', () => {
    const adapter = codeOf('src/kernel/orchestration/grant-adapter.ts');
    const scope = /function sourceScopeFor[\s\S]*?\r?\n}\r?\n/.exec(adapter)?.[0] ?? '';
    assert.ok(scope.length > 0, 'sourceScopeFor exists');
    for (const word of ['context', 'restrictive', 'obligation', 'metadata']) assert.equal(scope.toLowerCase().includes(word), false, `sourceScopeFor must not read ${word}`);
  });

  it('context reaches the grant source only as the digest and the decision validity ceiling', () => {
    const adapter = codeOf('src/kernel/orchestration/grant-adapter.ts');
    const reads = [...adapter.matchAll(/result\.context\?\.(\w+)/g)].map((match) => match[1]).sort();
    assert.deepEqual([...new Set(reads)], ['digest', 'validUntil']);
  });
});

describe('CORE-04 structure — obligation discharge has one in-process writer, and no route reaches it', () => {
  it('no HTTP adapter, administration or customer-route source imports the discharge writer', () => {
    const surfaces = [...walk('src/enterprise/adapters'), ...walk('src/enterprise/authority-administration'), ...walk('src/enterprise/api'), ...walk('src/enterprise/governed-action')];
    assert.ok(surfaces.length > 5);
    for (const file of surfaces) {
      const code = codeOf(file);
      assert.equal(/obligation-discharge|obligationDischarges|createObligationDischargeRecorder/.test(code), false, `${file} must not reach the obligation discharge writer`);
    }
  });

  it('the recorder states no resulting state: its input has no state, verified or satisfied field', () => {
    const contracts = codeOf('src/enterprise/obligation-discharge/contracts.ts');
    const input = /export interface ObligationDischargeRecordInput \{[\s\S]*?\r?\n\}/.exec(contracts)?.[0] ?? '';
    assert.ok(input.length > 0);
    for (const field of ['state', 'verified', 'satisfied', 'verificationClass', 'trusted']) assert.equal(new RegExp(`readonly ${field}\\b`).test(input), false, field);
  });
});
