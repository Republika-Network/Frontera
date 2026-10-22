import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/index.js';
import { EXTERNAL_AUTHORITY_SIGNER_EXTENSION_OPERATIONS, EXTERNAL_AUTHORITY_SIGNER_OPERATIONS } from '../external-authority-signer/index.js';
import { hasUnpairedSurrogate } from '../governed-action/identifiers.js';
import { EXECUTION_CAPABILITY_SIGNING_DOMAIN, hasUnpairedSurrogateCodeUnit } from '../execution-capability/index.js';

/**
 * G-02A structure: the verifier stands alone, nothing can sign a capability
 * yet, the internal grant stays internal, and TRADE-04C-S1 is untouched.
 * Measured against source, never a line number.
 */

const ROOT = 'src/enterprise/execution-capability';

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourcesUnder(path));
    else if (path.endsWith('.ts')) out.push(path.replace(/\\/g, '/'));
  }
  return out.sort();
}

/** Runtime import specifiers of a file: type-only imports and re-exports load nothing and are skipped. */
function runtimeSpecifiers(file: string): string[] {
  const code = codeOf(file).replace(/\b(?:import|export)\s+type\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g, ' ');
  return [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '').filter((specifier) => specifier.length > 0);
}

/** The runtime import closure of `entries`: every file it loads, and every bare module it names. */
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

describe('G-02A structure — the verifier is standalone', () => {
  const verifierClosure = closureOf([`${ROOT}/index.ts`]);

  it('the closure walk is real: it follows the verifier into the CORE-02 primitives and canonical JSON', () => {
    for (const required of [`${ROOT}/verifier.ts`, `${ROOT}/capability.ts`, 'src/enterprise/authority-authenticity/signature-verification.ts', 'src/enterprise/authority-authenticity/signature-envelope.ts', 'src/enterprise/governance-store/canonical-json.ts']) {
      assert.ok(verifierClosure.files.has(required), required);
    }
  });

  it('it loads exactly the capability codec, the CORE-02 envelope and verification primitives and canonical JSON — and node:crypto', () => {
    assert.deepEqual([...verifierClosure.files].sort(), [
      'src/enterprise/authority-authenticity/errors.ts',
      'src/enterprise/authority-authenticity/signature-envelope.ts',
      'src/enterprise/authority-authenticity/signature-verification.ts',
      'src/enterprise/execution-capability/capability.ts',
      'src/enterprise/execution-capability/index.ts',
      'src/enterprise/execution-capability/verifier.ts',
      'src/enterprise/governance-store/canonical-json.ts',
      'src/enterprise/governance-store/digest.ts',
    ]);
    assert.deepEqual([...verifierClosure.bare].sort(), ['node:crypto']);
  });

  it('it reaches no Host composition, Kernel, orchestration, store, grant runtime, configuration or I/O', () => {
    const forbidden = /^src\/kernel\/|^src\/enterprise\/(composition|host|orchestration|governed-action|configuration|api|adapters|bounded-grant-store|execution-governance)\/|^src\/features\/|sqlite-|in-memory-|-store\.ts$/;
    assert.deepEqual([...verifierClosure.files].filter((file) => forbidden.test(file)), []);
  });

  it('the reference ledger adds only its database and file-system access, never a network', () => {
    const ledger = closureOf([`${ROOT}/reference/consumption-ledger.ts`]);
    assert.deepEqual([...ledger.bare].sort(), ['better-sqlite3', 'node:crypto', 'node:fs', 'node:path']);
    assert.equal(verifierClosure.files.has(`${ROOT}/reference/consumption-ledger.ts`), false, 'the verifier entry point does not load the database');
  });
});

describe('G-02A structure — nothing can sign a capability before G-02B', () => {
  it('the module holds no private material and no signing call', () => {
    for (const file of sourcesUnder(ROOT)) {
      const code = codeOf(file);
      assert.equal(/createPrivateKey|privateKey|generateKeyPair|crypto\.sign\b|[^a-zA-Z.]sign\(|createHmac/i.test(code), false, `${file} must not hold or use signing material`);
    }
  });

  it('the authority signer and the external custody protocol offer no execution-capability operation', () => {
    const signer = readFileSync('src/enterprise/authority-authenticity/signer.ts', 'utf8');
    assert.equal(/ExecutionCapability|executionCapability/.test(signer), false);
    assert.deepEqual([...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS], ['signGrant', 'signRevocation', 'signRevocationState', 'signObligationDischargeState', 'signApprovalState']);
    assert.deepEqual([...EXTERNAL_AUTHORITY_SIGNER_EXTENSION_OPERATIONS], ['signDelegatedOfferCapability']);
  });

  it('the signing domain is registered once, with every other CORE-02 domain, and is prefix-free against them', () => {
    assert.equal(AUTHORITY_SIGNING_DOMAINS.executionCapability, EXECUTION_CAPABILITY_SIGNING_DOMAIN);
    assert.equal(EXECUTION_CAPABILITY_SIGNING_DOMAIN, 'frontera:authority-artifact:execution-capability:v1\n');
    const domains = Object.values(AUTHORITY_SIGNING_DOMAINS);
    assert.equal(new Set(domains).size, domains.length);
    for (const a of domains) for (const b of domains) if (a !== b) assert.equal(a.startsWith(b), false, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
  });
});

describe('G-02A structure — the internal grant stays internal; TRADE-04C-S1 is untouched', () => {
  it('the capability module imports neither the grant runtime nor any grant store', () => {
    for (const file of sourcesUnder(ROOT)) {
      assert.equal(runtimeSpecifiers(file).some((specifier) => /grant-runtime|bounded-grant-store|governed-action|orchestration/.test(specifier)), false, file);
    }
  });

  it('no token vocabulary: the capability is a CORE-02 artifact, not a JWT, macaroon, UCAN, OAuth or signed URL', () => {
    for (const file of sourcesUnder(ROOT)) assert.equal(/jwt|macaroon|ucan|oauth|signed_url|bearer/i.test(readFileSync(file, 'utf8')), false, file);
  });

  it('no S1 source imports or names the generic capability, and the S1 format and domain are unchanged', () => {
    for (const file of [
      'src/enterprise/authority-authenticity/delegated-offer-capability.ts',
      'src/enterprise/authority-authenticity/delegated-offer-capability-issuer.ts',
      'src/enterprise/xrpl-trade-rail/delegated-offer-authorization.ts',
      'src/enterprise/xrpl-trade-rail/delegated-offer-protocol.ts',
      'src/enterprise/xrpl-trade-rail/reference/reference-capability-ledger.ts',
      'src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.ts',
    ]) {
      assert.equal(/execution-capability|ExecutionCapability/.test(readFileSync(file, 'utf8')), false, file);
    }
    assert.equal(AUTHORITY_SIGNING_DOMAINS.delegatedOfferCapability, 'frontera:authority-artifact:xrpl-delegated-offer-capability:v1\n');
  });

  it('the generic module names no ledger, rail or vendor', () => {
    for (const file of sourcesUnder(ROOT)) assert.equal(/xrpl|lightning|stripe|x402|\bmpp\b|ledger sequence|offercreate/i.test(readFileSync(file, 'utf8')), false, file);
  });
});

describe('G-02A structure — one Unicode rule', () => {
  it('the capability identifier rule refuses exactly what SEC-INV-356 refuses', () => {
    for (const value of ['', 'plain', 'café', 'café', '🚀', '\ud800', '\udc00', 'a\ud800b', '\udc00\ud800', '\ud83d', 'x\ude80', '𐀀']) {
      assert.equal(hasUnpairedSurrogateCodeUnit(value), hasUnpairedSurrogate(value), JSON.stringify(value));
    }
  });
});
