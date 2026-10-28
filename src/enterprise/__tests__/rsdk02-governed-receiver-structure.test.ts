import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as governedReceiver from '../governed-receiver/index.js';

/**
 * RSDK-02B structure: the governed receiver is executor-side composition over
 * the existing G-02 executor. It mints, signs and holds no authority, imports
 * neither RSDK-01 nor `@aoc/protocol` (the shipped runtime keeps Protocol
 * type-only), adds no Host surface, and no Host module imports it. Measured
 * against source, never a line number.
 */

const MODULE = 'src/enterprise/governed-receiver';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) out.push(path.replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Every import specifier, type-only included: a type import of RSDK-01 or Protocol is refused too. */
function allSpecifiers(file: string): string[] {
  return [...codeOf(file).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

/** Runtime specifiers only: type-only imports load nothing. */
function runtimeSpecifiers(file: string): string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

/** The runtime import closure of `entries` within `src`, and every bare specifier it reaches. */
function closureOf(entries: readonly string[]): { readonly files: ReadonlySet<string>; readonly bare: ReadonlySet<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeSpecifiers(file)) {
      if (!specifier.startsWith('.')) {
        bare.add(specifier);
        continue;
      }
      const target = normalize(join(dirname(file), specifier)).replace(/\\/g, '/');
      const resolved = target.endsWith('.js') ? `${target.slice(0, -3)}.ts` : `${target}/index.ts`;
      if (existsSync(resolved)) pending.push(resolved);
    }
  }
  return { files, bare };
}

const SOURCES = sourcesUnder(MODULE);

describe('RSDK-02B structure — the governed receiver', () => {
  it('is exactly the four modules the design names, plus the demonstration policy', () => {
    assert.deepEqual(SOURCES, [`${MODULE}/asset-gate.ts`, `${MODULE}/contracts.ts`, `${MODULE}/demonstration-policy.ts`, `${MODULE}/index.ts`, `${MODULE}/receiver.ts`]);
  });

  it('never imports RSDK-01 or @aoc/protocol, not even for types, anywhere in its closure', () => {
    for (const file of SOURCES) {
      for (const specifier of allSpecifiers(file)) {
        assert.equal(/^@aoc\/protocol|sovereign-receiver-verification/.test(specifier), false, `${file} imports ${specifier}`);
      }
    }
    const closure = closureOf(SOURCES);
    for (const specifier of closure.bare) assert.equal(/^@aoc\/protocol|^@aoc-enterprise\/sovereign-receiver-verification/.test(specifier), false, `the closure reaches ${specifier}`);
  });

  it('reaches no signer, custody, issuer, gate, Host composition or Kernel', () => {
    const forbidden = /authority-authenticity\/(signer|custody|execution-capability-issuance)|execution-capability-issuance\/|execution-capability-gate\/|\/composition\/|\/host\/|\/kernel\/|receipt-signer|launcher\.ts$/;
    const reached = [...closureOf(SOURCES).files].filter((file) => forbidden.test(file));
    assert.deepEqual(reached, []);
  });

  it('holds no key, signs nothing and opens no server or file of its own', () => {
    for (const file of SOURCES) {
      const code = codeOf(file);
      assert.equal(/createPrivateKey|\bprivateKey\b|generateKeyPair|crypto\.sign\b|[^a-zA-Z.]sign\(|createHmac/.test(code), false, `${file} signs`);
      assert.equal(/createServer\(|\.listen\(|node:fs|node:net|node:http|fetch\(|process\.env/.test(code), false, `${file} does I/O`);
    }
  });

  it('adds no Host surface: no module outside it imports it', () => {
    // Static imports, re-exports and dynamic import() alike.
    const importers = sourcesUnder('src').filter((file) => !file.startsWith(`${MODULE}/`) && /(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]*governed-receiver\//.test(codeOf(file)));
    assert.deepEqual(importers, []);
  });

  it('does not export the demonstration policy, a capability or receipt schema, or any signing capability', () => {
    assert.deepEqual(Object.keys(governedReceiver).sort(), [
      'GOVERNED_RECEIVER_ASSET_REFUSALS',
      'GOVERNED_RECEIVER_LIMITS',
      'GOVERNED_RECEIVER_MODE',
      'SOVEREIGN_ASSET_IDENTIFIER_PATTERN',
      'createGovernedSovereignReceiver',
      'isSovereignAssetIdentifier',
    ]);
    assert.equal(/demonstration/.test(codeOf(`${MODULE}/index.ts`).replace(/See `[^`]*`/g, '')), false);
  });

  it('caps a bundle at 1 MiB and bounds the asset deadline', () => {
    assert.equal(governedReceiver.GOVERNED_RECEIVER_LIMITS.maximumBundleBytes, 1_048_576);
    assert.ok(governedReceiver.GOVERNED_RECEIVER_LIMITS.maximumAssetDeadlineMs <= 30_000);
    assert.ok(Object.isFrozen(governedReceiver.GOVERNED_RECEIVER_LIMITS));
  });

  it('reuses the existing pipeline and flow rather than restating them', () => {
    const receiver = codeOf(`${MODULE}/receiver.ts`);
    assert.ok(receiver.includes('createReferenceExecutorVerificationPipeline(configuration, clock, { resourcePermitted: isSovereignAssetIdentifier })'));
    assert.ok(receiver.includes('createReferenceExecutorExecutionFlow('));
    for (const file of SOURCES) {
      assert.equal(/createExecutionCapabilityVerifier|decodeExecutionCapabilityPresentation|reconstructHttpRequestBinding|timingSafeEqual|\.claim\(/.test(codeOf(file)), false, `${file} restates a G-02 primitive`);
    }
  });

  it('accepts exactly the sovereign asset identifiers @aoc/protocol mints', () => {
    const { isSovereignAssetIdentifier } = governedReceiver;
    assert.equal(isSovereignAssetIdentifier('aoc:sovereign-asset:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'), true);
    for (const value of ['cluster-eu-1', 'aoc:sovereign-asset:6F1D2C3B-4A5E-4F60-8A7B-9C0D1E2F3A4B', 'aoc:sovereign-asset:6f1d2c3b-4a5e-0f60-8a7b-9c0d1e2f3a4b', ' aoc:sovereign-asset:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', 42, undefined]) {
      assert.equal(isSovereignAssetIdentifier(value), false, String(value));
    }
  });
});
