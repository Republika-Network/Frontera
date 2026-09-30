import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CORE-07 — structural properties of the authority-state freshness boundary:
 * the ones about where code sits and what it may call, which a behavioural
 * test can pass by accident.
 */

const read = (file: string): string => readFileSync(file, 'utf8');
/** Source with comments removed, so a comment that *names* a thing is not mistaken for code that *does* it. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const MODULE = 'src/enterprise/authority-state-freshness';
const STORES = [
  'src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts',
  'src/enterprise/obligation-discharge/sqlite-obligation-discharge-store.ts',
  'src/enterprise/approval-authority/sqlite-approval-store.ts',
];

/** The text of the balanced `(...)` argument list that starts at `open` (the index of `(`). */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('unbalanced');
}

describe('CORE-07 — structure of the freshness boundary', () => {
  it('no network call inside a SQLite write transaction: every commit handed to a transition is synchronous', () => {
    for (const store of STORES) {
      const source = code(store);
      const calls = [...source.matchAll(/session\.transition\(/g)];
      assert.equal(calls.length, 1, `${store} makes exactly one transition call`);
      const args = argumentsAt(source, (calls[0]!.index ?? 0) + 'session.transition'.length);
      // The third argument is the local commit.
      const commit = args.slice(args.indexOf('() =>'));
      assert.ok(commit.length > 0, `${store}: a commit callback is passed`);
      assert.equal(/\bawait\b|\basync\b/.test(commit), false, `${store}: the commit handed to the transition must not await — it runs inside the write transaction`);
      assert.equal(/\banchor\s*\.|witness-client|http-transport/.test(source), false, `${store}: a store reaches the witness only through its session`);
    }
  });

  it('the transition orders prepare → local commit → finalize, and the commit is the only thing between them', () => {
    const session = code(`${MODULE}/session.ts`);
    const start = session.indexOf('function transition<T>');
    const body = session.slice(start, session.indexOf('function probe(', start));
    assert.ok(body.length > 0, 'the transition implementation is found');
    const prepare = body.indexOf('anchor.prepare(expected, proposed)');
    const commit = body.indexOf('committed = commit()');
    const finalize = body.indexOf('anchor.finalize(proposed)');
    assert.ok(prepare > 0 && commit > prepare && finalize > commit, 'prepare, then commit, then finalize');
    assert.equal(/\bawait\b/.test(body.slice(body.indexOf('committed = commit()') - 40, body.indexOf('committed = commit()') + 20)), false, 'the commit itself is not awaited');
  });

  it('every durable authority store establishes freshness before it is returned, and enrolls a genesis before committing it', () => {
    for (const store of STORES) {
      const source = code(store);
      const establish = source.indexOf('boundary.establish(');
      const returned = source.lastIndexOf('return store;');
      assert.ok(establish > 0 && establish < returned, `${store}: establish runs before the store is returned`);
      assert.ok(source.includes('boundary.genesisStoreId('), `${store}: a new store's genesis is enrolled at the witness`);
      assert.ok(source.includes('session?.observe('), `${store}: every verified read passes the floor`);
    }
  });

  it('the in-process witnesses of the discharge and approval stores remember the digest as well as the sequence', () => {
    for (const store of STORES.slice(1)) {
      const source = code(store);
      assert.ok(/state\.chainDigest !== witnessed\.chainDigest/.test(source), `${store}: same sequence, different digest is refused`);
      assert.equal(/let witnessed = -1/.test(source), false, `${store}: a bare number is not a witness`);
    }
  });

  it('no composition path enrolls an existing store: only the explicit ceremony passes an enrollment context', () => {
    const root = code('src/enterprise/composition/composition-root.ts');
    const compose = root.slice(root.indexOf('async function composeEnterprise('), root.indexOf('export function createDefaultEnterprise('));
    assert.equal(/enrollment/.test(compose), false, 'createEnterprise never passes an enrollment context');
    assert.equal(/verified-local-state-is-current/.test(root), false, 'the composition root never constructs one');
    const constructs = walk('src')
      .filter((file) => file.endsWith('.ts') && !file.includes('__tests__'))
      .filter((file) => /(?<!readonly )attestation:\s*'verified-local-state-is-current'/.test(code(file)));
    assert.deepEqual(constructs, [], 'no production source constructs an enrollment context');
    assert.ok(/attestation: 'verified-local-state-is-current'/.test(read('scripts/enroll-authority-state-freshness.mjs')), 'the operator ceremony is the one place that does');
  });

  it('the freshness module is vendor-neutral: node builtins and relative imports only, no ledger or chain SDK anywhere', () => {
    for (const file of walk(MODULE).filter((path) => path.endsWith('.ts'))) {
      for (const [, specifier] of code(file).matchAll(/from\s+'([^']+)'/g)) {
        assert.ok(specifier!.startsWith('node:') || specifier!.startsWith('.'), `${file} imports '${specifier}'`);
      }
      assert.ok(!/import\('(?!better-sqlite3)[^.n]/.test(code(file)), `${file}: no dynamic import of a vendor SDK`);
    }
    const manifests = ['package.json', ...walk('packages').filter((file) => file.endsWith('package.json') && !file.includes('node_modules')), ...walk('apps').filter((file) => file.endsWith('/package.json') && !file.includes('node_modules'))];
    const CHAIN = /^(?:ethers|web3|viem|@solana\/|bitcoinjs|@cosmjs\/|@polkadot\/|hardhat|truffle|@hyperledger\/)/;
    for (const manifest of manifests) {
      const pkg = JSON.parse(read(manifest)) as Record<string, Record<string, string> | undefined>;
      const names = Object.keys({ ...(pkg['dependencies'] ?? {}), ...(pkg['devDependencies'] ?? {}), ...(pkg['optionalDependencies'] ?? {}) });
      assert.deepEqual(names.filter((name) => CHAIN.test(name)), [], `${manifest} carries no blockchain dependency`);
    }
  });

  it('the Kernel, the feature runtimes and payment code never import the freshness module; it never imports the external signer', () => {
    const offenders = [...walk('src/kernel'), ...walk('src/features')]
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /authority-state-freshness/.test(code(file)));
    assert.deepEqual(offenders, []);
    for (const file of walk(MODULE).filter((path) => path.endsWith('.ts'))) {
      assert.equal(/external-authority-signer|authority-authenticity\/signer/.test(code(file)), false, `${file}: the freshness witness and the authority signer are separate roles`);
    }
  });

  it('the witness transport follows no redirect, takes no caller-supplied path and logs nothing', () => {
    const transport = code(`${MODULE}/http-transport.ts`);
    assert.equal(/headers\.location|\.location\b/.test(transport), false, 'no redirect is followed');
    assert.ok(transport.includes('new URL(AUTHORITY_STATE_WITNESS_PATHS[request.operation], origin)'), 'the only path is the protocol table entry');
    for (const file of walk(MODULE).filter((path) => path.endsWith('.ts'))) {
      assert.equal(/\bconsole\.|logger\./.test(code(file)), false, `${file} logs nothing — no credential or receipt can reach a log from here`);
    }
  });
});
