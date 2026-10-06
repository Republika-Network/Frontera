import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What destination approval is allowed to be, enforced structurally
 * (ANDREW-P0-03): organization-scoped governance state over the P0-01
 * identity and the P0-02 registry, reachable by an operator-plane authority —
 * and nothing that evaluates policy, issues or verifies grants, executes, signs,
 * names a rail or touches a network.
 */

const APPROVAL_ROOT = 'src/features/destination-runtime/approval';
const DURABLE_ROOT = 'src/enterprise/destination-approval';

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const APPROVAL_SOURCES = sourceFiles(APPROVAL_ROOT);
const DURABLE_SOURCES = sourceFiles(DURABLE_ROOT);
const ALL_SOURCES = [...APPROVAL_SOURCES, ...DURABLE_SOURCES];

/** Comments stripped: what is forbidden is code, not a word the prose explains. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

function importsOf(file: string): readonly string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/from '([^']+)'/g), ...text.matchAll(/import\('([^']+)'\)/g)].map((match) => match[1] ?? '');
}

describe('Destination approval boundaries (ANDREW-P0-03)', () => {
  it('has approval and durable sources to check', () => {
    assert.ok(APPROVAL_SOURCES.length >= 2, `approval sources: ${APPROVAL_SOURCES.length}`);
    assert.ok(DURABLE_SOURCES.length >= 4, `durable sources: ${DURABLE_SOURCES.length}`);
  });

  it('the approval port imports nothing but itself, the P0-01 identity and the P0-02 registry', () => {
    for (const file of APPROVAL_SOURCES) {
      for (const specifier of importsOf(file)) {
        assert.ok(specifier.startsWith('./') || specifier === '../domain/index.js' || specifier === '../registry/index.js', `${file} imports '${specifier}'`);
      }
    }
  });

  it('the durable store and service import only the destination runtime, SQLite, local files, a digest and the operator-plane authenticator types', () => {
    const allowed = new Set([
      'node:fs',
      'node:path',
      'node:crypto',
      'better-sqlite3',
      '../../features/destination-runtime/index.js',
      '../../features/destination-runtime/registry/index.js',
      '../../features/destination-runtime/approval/index.js',
      '../operator-control/operator-authenticator.js',
      '../operator-control/roles.js',
    ]);
    for (const file of DURABLE_SOURCES) {
      for (const specifier of importsOf(file)) assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports '${specifier}'`);
    }
    // The operator plane is a type-only dependency: no authenticator, credential or configuration code is loaded.
    for (const file of DURABLE_SOURCES) {
      for (const match of readFileSync(file, 'utf8').matchAll(/^import (type )?\{[^}]*\} from '(\.\.\/operator-control\/[^']+)'/gm)) assert.equal(match[1], 'type ', `${file} imports ${match[2] ?? ''} at runtime`);
    }
  });

  it('reaches no Kernel, policy, grant, governed action, trusted context, execution, signer, HTTP, hosted database or rail SDK', () => {
    const forbidden = [
      /kernel/i,
      /grant/i,
      /polic/i,
      /execution-runtime|execution-adapters|execution-governance|execution-outcome/,
      /governed-action/,
      /context-resolution|trusted-context/,
      /signer|authority-authenticity|external-authority/,
      /adapters\//,
      /\bhttps?\b|node:net|node:tls|undici|axios/,
      /xrpl|ripple|ethers|web3|viem|lightning|bolt11|lnd|lumx/i,
      /supabase|postgres|\bpg\b/i,
    ];
    for (const file of ALL_SOURCES) {
      for (const specifier of importsOf(file)) {
        for (const pattern of forbidden) assert.equal(pattern.test(specifier), false, `${file} imports '${specifier}' (${String(pattern)})`);
      }
    }
  });

  it('reads no ambient clock or randomness, reaches no network or process, and constructs no code', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /Math\.random/, /randomUUID|randomBytes/, /\bfetch\s*\(/, /\brequire\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bprocess\./, /setTimeout|setInterval/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('the feature port does no I/O and no hashing; the only dynamic import is the store loading better-sqlite3', () => {
    for (const file of APPROVAL_SOURCES) {
      const text = codeOf(file);
      assert.equal(/\bimport\s*\(/.test(text), false, file);
      assert.equal(/node:|better-sqlite3|createHash/.test(text), false, file);
    }
    for (const file of DURABLE_SOURCES) {
      for (const match of codeOf(file).matchAll(/\bimport\s*\(\s*'([^']+)'/g)) assert.equal(match[1], 'better-sqlite3', file);
    }
  });

  it('names no rail, ledger, wallet or provider in code, and no amount, asset or counterparty', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bxrpl?\b/i, /\bwallet\b/i, /\bledger\b/i, /ethereum|\bevm\b/i, /lightning|bolt11/i, /\blumx\b/i, /stripe/i, /\biban\b/i, /signTransaction/, /private[_-]?key/i, /\bamount\b/i, /\basset\b/i, /counterparty/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('defines no second identity algorithm: destinations are keyed by executionDestinationKey and nothing is normalized', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      assert.equal(/`\$\{[^}]*namespace[^}]*\}:/.test(text), false, `${file} spells a destination key itself`);
      for (const pattern of [/\.to(Lower|Upper)Case\s*\(/, /\.toLocale(Lower|Upper)Case\s*\(/, /\.normalize\s*\(/, /COLLATE\s+NOCASE/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      if (/destination_key|destinationKey/.test(text) && !file.endsWith('destination-approval-record.ts') && !file.endsWith('administration.ts') && !file.endsWith('index.ts')) {
        assert.match(text, /executionDestinationKey\(/, `${file} keys destinations without executionDestinationKey`);
      }
    }
  });

  it('never writes the registry, and never mutates or deletes governance history', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      assert.equal(/\.register\s*\(/.test(text), false, `${file} registers a destination`);
      assert.equal(/registered_destinations/.test(text), false, `${file} reaches into the registry's storage`);
      assert.equal(/UPDATE\s+destination_approval_(events|commands)/i.test(text), false, `${file} updates history`);
      assert.equal(/DELETE\s+FROM/i.test(text), false, `${file} deletes`);
    }
  });

  it('the ports expose exactly read + history, and approve + revoke — no edit, delete, rename or listing', () => {
    const text = codeOf(join(APPROVAL_ROOT, 'destination-approval.ts'));
    const reader = /export interface DestinationApprovalReaderPort \{([^}]*)\}/.exec(text)?.[1] ?? '';
    const store = /export interface DestinationApprovalStorePort extends DestinationApprovalReaderPort \{([^}]*)\}/.exec(text)?.[1] ?? '';
    assert.deepEqual([...reader.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]), ['read', 'history']);
    assert.deepEqual([...store.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]), ['approve', 'revoke']);
  });

  it('every read names an organization: the query has an organizationId and there is no cross-organization listing', () => {
    const text = codeOf(join(APPROVAL_ROOT, 'destination-approval.ts'));
    const query = /export interface DestinationApprovalQuery \{([^}]*)\}/.exec(text)?.[1] ?? '';
    assert.deepEqual([...query.matchAll(/readonly (\w+):/g)].map((match) => match[1]), ['organizationId', 'destination']);
    for (const file of ALL_SOURCES) assert.equal(/SELECT[^`]*FROM destination_approval_events WHERE destination_key = \?/i.test(codeOf(file)), false, `${file} reads a destination across organizations`);
  });

  it('commands carry no organization, actor, basis or state: those come from the trusted authority', () => {
    const text = codeOf(join(APPROVAL_ROOT, 'destination-approval.ts'));
    for (const name of ['ApproveDestinationCommand', 'RevokeDestinationCommand']) {
      const body = new RegExp(`export interface ${name} \\{([^}]*)\\}`).exec(text)?.[1] ?? '';
      const fields = [...body.matchAll(/readonly (\w+)\??:/g)].map((match) => match[1]);
      for (const field of fields) assert.ok(['destination', 'expiresAt', 'idempotencyKey'].includes(field ?? ''), `${name} states ${field ?? ''}`);
    }
  });

  it('only the administrative service constructs an authenticated authority', () => {
    for (const file of ALL_SOURCES) {
      if (file.endsWith('administration.ts')) continue;
      // The one exception is the input check copying an authority it was handed (`values['organizationId']`).
      assert.equal(/authenticated:\s*true\s*,\s*organizationId:\s*(?!\s|values\[)/.test(codeOf(file)), false, `${file} builds an authority`);
    }
    assert.match(codeOf(join(DURABLE_ROOT, 'administration.ts')), /authenticator\.authorize\(/);
  });

  it('is exported from neither the P0-01 barrel, the P0-02 registry barrel, nor the Enterprise public barrel', () => {
    assert.equal(/approv/i.test(codeOf('src/features/destination-runtime/index.ts')), false);
    assert.equal(/approv/i.test(codeOf('src/features/destination-runtime/registry/index.ts')), false);
    assert.equal(/destination-approval/.test(readFileSync('src/enterprise/index.ts', 'utf8')), false);
  });
});
