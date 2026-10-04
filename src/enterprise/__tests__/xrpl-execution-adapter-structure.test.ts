import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ANDREW-P0-06 — structural boundaries of the XRPL Execution Adapter.
 *
 * Source scans, comments stripped (string literals kept, because a literal is
 * where an endpoint or a secret would hide). The adapter is a translator below
 * the grant: it reaches no governance state, no network client, no clock and
 * no key, and nothing that decides authority reaches it.
 */

const XRPL_DIR = 'src/enterprise/execution-adapters/xrpl';

function walk(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== '__tests__' && name !== 'tests' && name !== 'fixtures') out.push(...walk(full));
    } else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full.split('\\').join('/'));
  }
  return out;
}

function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split(/\r?\n/)
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote !== undefined) {
          if (char === quote && line[index - 1] !== '\\') quote = undefined;
          continue;
        }
        if (char === "'" || char === '"' || char === '`') {
          quote = char;
          continue;
        }
        if (char === '/' && line[index + 1] === '/') return line.slice(0, index);
      }
      return line;
    })
    .join('\n');
}

const imports = (file: string): readonly string[] => [...readFileSync(file, 'utf8').matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

const SOURCES = walk(XRPL_DIR);

describe('ANDREW-P0-06 structure — the XRPL adapter module', () => {
  it('has the expected production sources', () => {
    assert.deepEqual([...SOURCES].sort(), [
      `${XRPL_DIR}/configuration.ts`,
      `${XRPL_DIR}/contracts.ts`,
      `${XRPL_DIR}/index.ts`,
      `${XRPL_DIR}/payment-translation.ts`,
      `${XRPL_DIR}/settlement.ts`,
      `${XRPL_DIR}/xrpl-codec.ts`,
      `${XRPL_DIR}/xrpl-execution-adapter.ts`,
    ]);
  });

  it('imports only P0-01 identity, the execution port, P9 monetary primitives, node:crypto and itself', () => {
    const allowed = new Set([
      '../../../features/destination-runtime/index.js',
      '../../../features/execution-runtime/index.js',
      '../../../features/monetary-runtime/index.js',
      'node:crypto',
      './contracts.js',
      './configuration.js',
      './payment-translation.js',
      './settlement.js',
      './xrpl-codec.js',
      './xrpl-execution-adapter.js',
    ]);
    for (const file of SOURCES) for (const specifier of imports(file)) assert.ok(allowed.has(specifier), `${file} imports ${specifier}`);
  });

  it('reads no destination registry, approval store, trusted context, policy, Kernel, grant store, governance store or HTTP administration', () => {
    const forbidden = /destination-registry|destination-approval|trusted-context|policy|kernel|grant-runtime|bounded-grant|exercise-control|emergency-control|governance-store|governed-action|authority-administration|\/api\/|\/host\/|composition|execution-outcome|execution-resolution|DestinationRegistry|DestinationApproval|ContextProvider|evaluatePolicy|resolveContext/i;
    for (const file of SOURCES) {
      for (const specifier of imports(file)) assert.equal(forbidden.test(specifier), false, `${file} imports ${specifier}`);
      assert.equal(/\b(lookup|isApproved|approvalState|evaluate|enforce|issue|revoke|prepareAttempt|recordTerminal)\s*\(/.test(codeOf(file)), false, `${file} calls a governance operation`);
    }
  });

  it('opens no network client: no http/https/net/tls/dns/dgram, no fetch, WebSocket, ws, undici or axios', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/from\s+['"](?:node:)?(?:https?|net|tls|dns|dgram|http2)['"]|from\s+['"](?:ws|undici|axios|node-fetch|xrpl|ripple-[\w-]+)['"]/.test(code), false, file);
      assert.equal(/\bfetch\s*\(|\bWebSocket\b|\bnew\s+(?:net\.)?Socket\s*\(|\.connect\s*\(/.test(code), false, file);
    }
  });

  it('hardcodes no endpoint, network or faucet: no URL, no testnet/mainnet/devnet literal', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/wss?:\/\/|https?:\/\/|altnet|rippletest|ripple\.com|xrplcluster|faucet/i.test(code), false, file);
      assert.equal(/testnet|mainnet|devnet/i.test(code), false, `${file}: the network is the transport's configuration, not the adapter's`);
    }
  });

  it('holds and names no key material, and builds no live-ledger field', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/\bseed\b|secret|mnemonic|private[_-]?key|\bsign(Transaction)?\s*\(|\bWallet\b|keypair|\bprocess\.env\b/i.test(code), false, `${file} must hold no key`);
      assert.equal(/\bAccount\s*:|\bFee\b|\bSequence\b|LastLedgerSequence|\bMemos?\b|DestinationTag|SendMax|\bPaths\b|\bFlags\b|tfPartialPayment|autofill/.test(code), false, `${file} must state business intent only`);
    }
  });

  it('never converts money through a number, and holds no clock, timer or retry loop', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/\bNumber\s*\(|\bNumber\.|parseFloat|parseInt|toFixed|toPrecision|\bMath\./.test(code), false, `${file} must not convert through a number`);
      assert.equal(/Date\.now|new Date|setTimeout|setInterval|setImmediate|\bwhile\s*\(\s*true|\bretry/i.test(code), false, file);
    }
  });

  it('calls the transport from exactly one place, and invokes no other adapter', () => {
    const adapter = codeOf(`${XRPL_DIR}/xrpl-execution-adapter.ts`);
    assert.equal([...adapter.matchAll(/submitPayment\s*\.\s*call\s*\(/g)].length, 1);
    for (const file of SOURCES) assert.equal(/\b[\w$]*[Aa]dapter\s*\.\s*execute\s*\(/.test(codeOf(file)), false, file);
  });
});

describe('ANDREW-P0-06 structure — nothing that decides authority reaches the XRPL adapter', () => {
  it('no policy, trusted-context, Kernel, grant, execution-runtime, destination, governed-action, Host or composition source imports it', () => {
    const roots = [
      'src/kernel',
      'src/features/grant-runtime',
      'src/features/execution-runtime',
      'src/features/destination-runtime',
      'src/features/domain-policy-pack-runtime',
      'src/features/monetary-runtime',
      'src/enterprise/trusted-context',
      'src/enterprise/destination-registry',
      'src/enterprise/destination-approval',
      'src/enterprise/governed-action',
      'src/enterprise/execution-governance',
      'src/enterprise/composition',
      'src/enterprise/host',
      'src/enterprise/api',
      'src/enterprise/execution-adapters/generic-http',
    ];
    for (const file of roots.flatMap(walk)) {
      assert.equal(/execution-adapters\/xrpl|createXrplExecutionAdapter|XrplPayment/.test(readFileSync(file, 'utf8')), false, `${file} must not reach the XRPL adapter`);
    }
  });

  it('is not on the Enterprise barrel, the frozen API surface or the Host boot', () => {
    assert.equal(readFileSync('src/enterprise/index.ts', 'utf8').includes('xrpl'), false);
    if (existsSync('release/api-surface.v1.json')) assert.equal(/xrpl/i.test(readFileSync('release/api-surface.v1.json', 'utf8')), false);
  });

  it('adds no XRPL dependency: the root manifest and lockfile name no xrpl, ripple or ws package', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({ ...manifest['dependencies'], ...manifest['devDependencies'], ...manifest['optionalDependencies'] });
    assert.equal(names.some((name) => /xrpl|ripple|^ws$/.test(name)), false, names.join(', '));
    assert.equal(/"node_modules\/(?:xrpl|ripple-[\w-]+|@xrplf\/[\w-]+)"/.test(readFileSync('package-lock.json', 'utf8')), false);
  });
});
