import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * What the destination registry is allowed to be, enforced structurally
 * (ANDREW-P0-02): a membership record — known or unknown — that holds no
 * approval state, reaches no Kernel, grant, policy or approval code, names no
 * rail, and touches no network.
 */

const REGISTRY_ROOT = 'src/features/destination-runtime/registry';
const DURABLE_ROOT = 'src/enterprise/destination-registry';

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

const REGISTRY_SOURCES = sourceFiles(REGISTRY_ROOT);
const DURABLE_SOURCES = sourceFiles(DURABLE_ROOT);
const ALL_SOURCES = [...REGISTRY_SOURCES, ...DURABLE_SOURCES];

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

describe('Destination registry boundaries (ANDREW-P0-02)', () => {
  it('has registry and durable sources to check', () => {
    assert.ok(REGISTRY_SOURCES.length >= 3, `registry sources: ${REGISTRY_SOURCES.length}`);
    assert.ok(DURABLE_SOURCES.length >= 2, `durable sources: ${DURABLE_SOURCES.length}`);
  });

  it('the registry port imports nothing but itself and the P0-01 identity primitive', () => {
    for (const file of REGISTRY_SOURCES) {
      for (const specifier of importsOf(file)) {
        assert.ok(specifier.startsWith('./') || specifier === '../domain/index.js', `${file} imports '${specifier}'`);
      }
    }
  });

  it('the durable registry imports only the destination runtime, better-sqlite3 and local filesystem paths', () => {
    const allowed = new Set(['node:fs', 'node:path', 'better-sqlite3', '../../features/destination-runtime/index.js', '../../features/destination-runtime/registry/index.js']);
    for (const file of DURABLE_SOURCES) {
      for (const specifier of importsOf(file)) assert.ok(specifier.startsWith('./') || allowed.has(specifier), `${file} imports '${specifier}'`);
    }
  });

  it('reaches no Kernel, grant, policy, approval, execution, HTTP, configuration or rail SDK code', () => {
    const forbidden = [
      /kernel/i,
      /grant/i,
      /polic/i,
      /approv/i,
      /execution-runtime|execution-outcome/,
      /governed-action/,
      /context-resolution/,
      /configuration/,
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
      for (const pattern of [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /Math\.random/, /randomUUID/, /\bfetch\s*\(/, /\brequire\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /\bprocess\./]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('the only dynamic import is the durable store loading better-sqlite3', () => {
    for (const file of REGISTRY_SOURCES) assert.equal(/\bimport\s*\(/.test(codeOf(file)), false, file);
    for (const file of DURABLE_SOURCES) {
      for (const match of codeOf(file).matchAll(/\bimport\s*\(\s*'([^']+)'/g)) assert.equal(match[1], 'better-sqlite3', file);
    }
  });

  it('names no rail, ledger, wallet or provider in code, and keeps no hardcoded namespace list', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\bxrpl?\b/i, /\bwallet\b/i, /\bledger\b/i, /ethereum|\bevm\b/i, /lightning|bolt11/i, /\blumx\b/i, /stellar/i, /stripe/i, /\biban\b/i, /signTransaction/, /private[_-]?key/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('holds no governance state — no approval, trust, authorization, revocation, expiry or status vocabulary in code', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/approv\w*/i, /\btrust\w*/i, /authori[sz]\w*/i, /\ballow\w*/i, /revok\w*|revocation/i, /expir\w*/i, /\bstatus\b/i, /\bdenied\b|\bdeny\b/i, /\blabel\b/i]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
  });

  it('normalizes nothing — no trim, case fold or Unicode normalization of an identity', () => {
    for (const file of REGISTRY_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/\.trim\w*\s*\(/, /\.to(Lower|Upper)Case\s*\(/, /\.toLocale(Lower|Upper)Case\s*\(/, /\.normalize\s*\(/]) {
        assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      }
    }
    // The durable store's one `.trim()` checks that its *file path* is not blank; it never touches a destination.
    for (const file of DURABLE_SOURCES) {
      const text = codeOf(file);
      assert.equal([...text.matchAll(/\.trim\w*\s*\(/g)].length, [...text.matchAll(/\bdbPath\.trim\(\)/g)].length, `${file} trims something other than its file path`);
      for (const pattern of [/\.to(Lower|Upper)Case\s*\(/, /\.toLocale(Lower|Upper)Case\s*\(/, /\.normalize\s*\(/, /COLLATE\s+NOCASE/i]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
    }
  });

  it('defines its own key from P0-01 and no second identity algorithm — no hashing, no separator of its own', () => {
    for (const file of ALL_SOURCES) {
      const text = codeOf(file);
      for (const pattern of [/createHash|node:crypto|sha256|digest/i, /`\$\{[^}]*namespace[^}]*\}:/]) assert.equal(pattern.test(text), false, `${file}: ${String(pattern)}`);
      if (/destination_key|destinationKey/.test(text)) assert.match(text, /executionDestinationKey\(/, `${file} keys destinations without executionDestinationKey`);
    }
  });

  it('the registry port exposes exactly lookup and register — no update, delete, approve, revoke or expire', () => {
    const text = codeOf(join(REGISTRY_ROOT, 'destination-registry.ts'));
    const reader = /export interface DestinationRegistryReaderPort \{([^}]*)\}/.exec(text)?.[1] ?? '';
    const store = /export interface DestinationRegistryPort extends DestinationRegistryReaderPort \{([^}]*)\}/.exec(text)?.[1] ?? '';
    assert.deepEqual([...reader.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]), ['lookup']);
    assert.deepEqual([...store.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]), ['register']);
  });

  it('the registration record states exactly identity and registration provenance', () => {
    const text = codeOf(join(REGISTRY_ROOT, 'destination-registry.ts'));
    const record = /export interface DestinationRegistration \{([^}]*)\}/.exec(text)?.[1] ?? '';
    assert.deepEqual([...record.matchAll(/readonly (\w+):/g)].map((match) => match[1]), ['destination', 'destinationKey', 'registeredBy', 'registeredAt']);
  });

  it('the P0-01 root barrel does not export the registry', () => {
    const barrel = readFileSync('src/features/destination-runtime/index.ts', 'utf8');
    assert.equal(/registry/.test(barrel.replace(/\/\*[\s\S]*?\*\//g, ' ')), false);
  });

  it('the durable registry is not composed into the Enterprise Host or exported from its public barrel', () => {
    assert.equal(/destination-registry/.test(readFileSync('src/enterprise/index.ts', 'utf8')), false);
  });
});
