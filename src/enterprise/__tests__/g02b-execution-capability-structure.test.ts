import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/index.js';
import { EXECUTION_CAPABILITY_FIELDS, EXECUTION_CAPABILITY_FORMAT, EXECUTION_CAPABILITY_SIGNING_DOMAIN } from '../execution-capability/index.js';

/**
 * G-02B structure: issuance is an internal, opt-in service whose one caller
 * is the G-02C0 pre-send gate — no route, no adapter, no governed-path call
 * site, no public export — the
 * custody operation is structured, the G-02A wire contract is unchanged and
 * the issuance modules load nothing beyond the database. Measured against
 * source (comments stripped), never a line number.
 */

const ISSUANCE = 'src/enterprise/execution-capability-issuance';

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

function sourcesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...sourcesUnder(path));
    } else if (path.endsWith('.ts')) {
      out.push(path.replace(/\\/g, '/'));
    }
  }
  return out.sort();
}

function runtimeSpecifiers(file: string): string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

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
      assert.ok(existsSync(resolved), `${file} imports ${specifier}, resolved to ${resolved}`);
      pending.push(resolved);
    }
  }
  return { files, bare };
}

describe('G-02B structure — issuance has one caller (the G-02C0 gate), no route and no public surface', () => {
  it('the measured sources exist', () => {
    assert.deepEqual(sourcesUnder(ISSUANCE), [`${ISSUANCE}/index.ts`, `${ISSUANCE}/issuance-ledger.ts`, `${ISSUANCE}/issuer.ts`]);
  });

  it('only the Host composition and the G-02C0 gate import the issuer: no governed path, exercise gate, adapter, API or orchestration module reaches it', () => {
    const importers: string[] = [];
    for (const root of ['src/enterprise', 'src/features', 'src/kernel', 'src/runtime']) {
      for (const file of sourcesUnder(root)) {
        if (file.startsWith(`${ISSUANCE}/`)) continue;
        if (runtimeSpecifiers(file).some((specifier) => specifier.includes('execution-capability-issuance/')) || /from ['"][^'"]*execution-capability-issuance\//.test(codeOf(file))) importers.push(file);
      }
    }
    // G-02C0: the gate imports the issuer's *types* only; the issuer it calls is the Host's slot, handed to it by the composition root.
    assert.deepEqual(importers.sort(), ['src/enterprise/composition/composition-root.ts', 'src/enterprise/execution-capability-gate/gate.ts', 'src/enterprise/host/enterprise-host.ts']);
    assert.equal(runtimeSpecifiers('src/enterprise/execution-capability-gate/gate.ts').some((specifier) => specifier.includes('execution-capability-issuance/')), false, 'type-only');
  });

  it('no HTTP route, API contract or enterprise export names an execution capability', () => {
    for (const file of [...sourcesUnder('src/enterprise/api'), ...sourcesUnder('src/enterprise/adapters'), 'src/enterprise/index.ts', 'src/index.ts']) {
      assert.equal(/execution-capabilit|ExecutionCapability|executionCapabilit/.test(codeOf(file)), false, file);
    }
  });

  it('the governed-action result and the validated execution action carry no capability', () => {
    for (const file of [...sourcesUnder('src/enterprise/governed-action'), ...sourcesUnder('src/features/execution-runtime'), ...sourcesUnder('src/enterprise/execution-adapters'), ...sourcesUnder('src/enterprise/execution-governance')]) {
      assert.equal(/execution-capabilit|ExecutionCapability|signExecutionCapability/.test(codeOf(file)), false, file);
    }
  });

  it('the issuance modules load only the authority boundary, the capability codec, canonical JSON and SQLite — no network, no adapter, no store of another kind', () => {
    const closure = closureOf([`${ISSUANCE}/index.ts`]);
    // The grant runtime (for the custody rule's grant checks) names Node's crypto module both ways; nothing else is loaded.
    const allowed = new Set(['better-sqlite3', 'crypto', 'node:crypto', 'node:fs', 'node:path']);
    assert.deepEqual([...closure.bare].filter((specifier) => !allowed.has(specifier)), []);
    assert.ok(closure.bare.has('better-sqlite3') && closure.files.has('src/enterprise/authority-authenticity/execution-capability-issuance.ts'), 'the walk is real');
    const forbidden = /^src\/enterprise\/(composition|host|orchestration|governed-action|api|adapters|execution-adapters|execution-governance|governance-store\/(?!canonical-json|digest)|bounded-grant-store\/sqlite)/;
    assert.deepEqual([...closure.files].filter((file) => forbidden.test(file)), []);
  });
});

describe('G-02B structure — the custody operation is structured, and the capability is G-02A’s', () => {
  it('no generic byte signing: the issuance code holds no key and calls no signing primitive', () => {
    for (const file of [...sourcesUnder(ISSUANCE), 'src/enterprise/authority-authenticity/execution-capability-issuance.ts']) {
      assert.equal(/createPrivateKey|privateKeyPem|generateKeyPair|cryptoSign|crypto\.sign\b|[^a-zA-Z.]sign\(|createHmac/.test(codeOf(file)), false, file);
    }
    const protocol = codeOf('src/enterprise/external-authority-signer/protocol.ts');
    assert.ok(protocol.includes("signExecutionCapability: '/v1/sign/execution-capability'"));
    assert.equal(/'\/(v1\/)?sign'/.test(protocol), false, 'no generic /sign route');
  });

  it('the signer signs exactly G-02A’s signing bytes of the record its rule accepted, and nothing else under that domain', () => {
    const signer = codeOf('src/enterprise/authority-authenticity/signer.ts');
    assert.equal(signer.split('executionCapabilitySigningBytes(').length - 1, 1, 'one signing site');
    assert.ok(signer.includes('signBytes(executionCapabilitySigningBytes(ruling.capability))'));
    assert.equal(/EXECUTION_CAPABILITY_SIGNING_DOMAIN/.test(signer), false, 'the domain is never concatenated by hand');
  });

  it('the G-02A wire contract is unchanged: format, signing domain and the eighteen fields — and no nonce field', () => {
    assert.equal(EXECUTION_CAPABILITY_FORMAT, 'frontera.execution-capability.v1');
    assert.equal(EXECUTION_CAPABILITY_SIGNING_DOMAIN, 'frontera:authority-artifact:execution-capability:v1\n');
    assert.equal(AUTHORITY_SIGNING_DOMAINS.executionCapability, EXECUTION_CAPABILITY_SIGNING_DOMAIN);
    assert.deepEqual([...EXECUTION_CAPABILITY_FIELDS], ['action', 'actionBinding', 'audience', 'capabilityId', 'consumption', 'executionId', 'expiresAt', 'format', 'grantReference', 'issuedAt', 'issuer', 'issuerKeyId', 'onBehalfOfActorId', 'organizationId', 'resource', 'statusRequirement', 'subjectActorId', 'trustDomain']);
    assert.equal(sourcesUnder('src/enterprise/execution-capability').some((file) => /nonce/i.test(codeOf(file))), false, 'the executor-side module knows no nonce');
  });

  it('TRADE-04C-S1 is untouched: its domain, its extension path and its rule module', () => {
    assert.equal(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability, 'frontera:authority-artifact:xrpl-delegated-offer-capability:v1\n');
    for (const file of ['src/enterprise/authority-authenticity/delegated-offer-capability.ts', 'src/enterprise/authority-authenticity/delegated-offer-capability-issuer.ts']) {
      assert.equal(/execution-capability|ExecutionCapability/.test(readFileSync(file, 'utf8')), false, file);
    }
  });
});
