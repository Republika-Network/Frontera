import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ANDREW-P0-04 — what trusted destination context may reach, enforced
 * structurally, read from the TypeScript sources with comments stripped (so
 * documentation that names a forbidden thing to forbid it is not mistaken for
 * a dependency on it).
 */

const PROVIDER = 'src/enterprise/trusted-context/destination-context.ts';

function codeOf(file: string): string {
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

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/from ['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').sort();
}

describe('ANDREW-P0-04 structure — the destination context provider reads, and reaches nothing else', () => {
  it('imports only the context runtime, the destination runtime (identity, registry reader, approval reader), the Kernel port type and a digest', () => {
    assert.deepEqual([...new Set(importsOf(PROVIDER))], [
      '../../features/context-resolution-runtime/index.js',
      '../../features/destination-runtime/approval/index.js',
      '../../features/destination-runtime/index.js',
      '../../features/destination-runtime/registry/index.js',
      '../../kernel/index.js',
      'node:crypto',
    ]);
    assert.match(codeOf(PROVIDER), /import type \{ ContextProvider \} from '\.\.\/\.\.\/kernel\/index\.js'/, 'the Kernel is imported for the port type only');
  });

  it('reaches no rail, payment adapter, signer, execution, grant, HTTP, SQL or durable store', () => {
    const code = codeOf(PROVIDER);
    const forbidden = [
      /xrpl/i,
      /ripple/i,
      /testnet/i,
      /wallet/i,
      /signer|signing|sign\(/i,
      /execution-runtime|execution-adapter|adapters\//,
      /grant-runtime|grant-adapter|bounded-grant/,
      /better-sqlite3|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/,
      /destination-registry\/|destination-approval\//,
      /createDestinationApprovalAdministration|administration/,
      /node:http|node:https|node:net|\bfetch\s*\(/,
      /Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random/,
    ];
    for (const pattern of forbidden) assert.equal(pattern.test(code), false, `${PROVIDER} must not match ${String(pattern)}`);
  });

  it('invokes no governance mutation: no register, approve, revoke, and no history walk', () => {
    const code = codeOf(PROVIDER);
    for (const call of [/\.register\s*\(/, /\.approve\s*\(/, /\.revoke\s*\(/, /\.history\s*\(/, /\.close\s*\(/]) assert.equal(call.test(code), false, String(call));
  });

  it('is typed against the read ports only, narrowed to the one read each', () => {
    const code = codeOf(PROVIDER);
    assert.match(code, /registry: Pick<DestinationRegistryReaderPort, 'lookup'>/);
    assert.match(code, /approvals: Pick<DestinationApprovalReaderPort, 'read'>/);
    assert.equal(/DestinationRegistryPort\b|DestinationApprovalStorePort\b|DestinationGovernanceAuthority\b/.test(code), false, 'no write port or authority type is named');
  });

  it('keys destinations with P0-01 only: no second key algorithm, no normalization', () => {
    const code = codeOf(PROVIDER);
    assert.match(code, /executionDestinationKey\(/);
    assert.match(code, /parseExecutionDestination\(/);
    assert.equal(/\.toLowerCase\(|\.toUpperCase\(|\.trim\(|\.normalize\(/.test(code), false);
    assert.equal(/`\$\{[^}]*namespace[^}]*\}:/.test(code), false, 'never spells a key itself');
  });

  it('never states a verdict: it produces observations, not allow/deny/hold', () => {
    const code = codeOf(PROVIDER);
    for (const pattern of [/'allowed'|'denied'|'approval_required'|'indeterminate'|'withheld'/, /\bdeny\b|\bhold\b/i, /reasonCode/]) assert.equal(pattern.test(code), false, String(pattern));
  });
});

describe('ANDREW-P0-04 structure — destination truth stays out of policy, the Kernel, the context runtime and the intake', () => {
  it('policy and enforcement code import no destination store, registry, approval or trusted-context composition', () => {
    const files = [...walk('src/features/domain-policy-pack-runtime'), ...walk('src/features/action-enforcement'), ...walk('src/features/policy-pack-foundation')];
    assert.ok(files.length > 10);
    for (const file of files) {
      const code = codeOf(file);
      assert.equal(/from ['"][^'"]*(destination-runtime|destination-registry|destination-approval|trusted-context|better-sqlite3)/.test(code), false, `${file} must receive facts, not read destination state`);
    }
  });

  it('the Kernel and the context runtime stay destination-neutral: they carry the counterparty, never interpret it', () => {
    for (const file of [...walk('src/kernel'), ...walk('src/features/context-resolution-runtime')]) {
      const code = codeOf(file);
      assert.equal(/destination-runtime|destination-registry|destination-approval|ExecutionDestination/.test(code), false, `${file} must not interpret destinations`);
    }
  });

  it('the destination stores stay unaware of trusted context (P0-02 / P0-03 unchanged in direction)', () => {
    for (const file of [...walk('src/features/destination-runtime'), ...walk('src/enterprise/destination-registry'), ...walk('src/enterprise/destination-approval')]) {
      assert.equal(/context-resolution|trusted-context/.test(codeOf(file)), false, file);
    }
  });

  it('the governed-action intake declares no governance-state field: the closed key set is unchanged but for P0-09 reconsideration', () => {
    const intent = codeOf('src/enterprise/governed-action/intent.ts');
    const declared = /const DECLARED_KEYS[^=]*= new Set\(\[([^\]]*)\]\)/.exec(intent)?.[1] ?? '';
    assert.deepEqual(
      [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1]),
      // ANDREW-P0-09 adds `reconsideration`: it names an earlier request and a reason, and asserts no governance state.
      ['action', 'resource', 'counterparty', 'amount', 'parameters', 'expectedGovernanceProfile', 'assertedContext', 'correlationId', 'idempotencyKey', 'reconsideration'],
    );
    // Its own vocabulary is closed to exactly `of` and `reason`: no approval, destination or state can ride on it.
    assert.match(intent, /key !== 'of' && key !== 'reason'/);
  });

  it('the resolution query gains the typed counterparty axis only — still no free-form bag', () => {
    const port = codeOf('src/features/context-resolution-runtime/domain/context-resolver-port.ts');
    const query = /export interface ContextResolutionQuery \{([\s\S]*?)\r?\n\}/.exec(port)?.[1] ?? '';
    assert.deepEqual(
      [...query.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]),
      ['keys', 'actorId', 'trustDomainId', 'action', 'resourceScope', 'organizationId', 'targetId', 'counterpartyId', 'at'],
    );
    assert.equal(/Record<string|\[key: string\]/.test(query), false);
  });

  it('the destination context is not on a public barrel or an HTTP route', () => {
    assert.equal(/trusted-context|destination-context/.test(readFileSync('src/enterprise/index.ts', 'utf8')), false);
    for (const file of [...walk('src/enterprise/api'), ...walk('src/enterprise/adapters'), ...walk('src/enterprise/host')]) {
      assert.equal(/destination-context|createDestinationContextProvider/.test(codeOf(file)), false, file);
    }
  });
});
