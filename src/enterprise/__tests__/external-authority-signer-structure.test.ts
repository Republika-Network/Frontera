import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * CORE-02 — structural rules a later change cannot quietly undo.
 *
 * - CORE stays vendor-neutral: no KMS/HSM SDK and no cloud key vocabulary in
 *   the Kernel, the governed runtimes, the stores or the authenticity module.
 * - The custody boundary stays structured: no generic byte-signing operation,
 *   no key export, and nothing in CORE knows how signatures are transported.
 * - The external composition path cannot reach a private key: it returns
 *   before any private-key parsing, has no fallback branch, and the external
 *   configuration never reads the key variable's value.
 * - TD-5: the authority key never becomes a passport key.
 *
 * Measured over source with comments stripped, never over prose.
 */

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests' || name === 'fixtures') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

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

function importsOf(file: string): readonly string[] {
  return [...codeOf(file).matchAll(/from\s+'([^']+)'|import\(\s*'([^']+)'\s*\)|require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? '');
}

/** Slices `code` from `start` to the matching close of the first `{` after it. */
function block(code: string, start: string): string {
  const at = code.indexOf(start);
  assert.ok(at !== -1, `${start} must exist`);
  const open = code.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(at, index + 1);
    }
  }
  throw new Error(`unbalanced block after ${start}`);
}

const CORE_ROOTS = [
  'src/kernel',
  'src/features/grant-runtime',
  'src/features/context-resolution-runtime',
  'src/features/obligation-runtime',
  'src/features/approval-runtime',
  'src/features/domain-policy-pack-runtime',
  'src/features/execution-runtime',
  'src/enterprise/authority-authenticity',
  'src/enterprise/bounded-grant-store',
  'src/enterprise/obligation-discharge',
  'src/enterprise/approval-authority',
] as const;
const EXTERNAL_ROOT = 'src/enterprise/external-authority-signer';
const EXTERNAL_CLIENT = sourceFiles(EXTERNAL_ROOT).filter((file) => !file.includes('/reference/'));

const VENDOR_SDK = /aws-sdk|@aws-sdk\/|@google-cloud\/|googleapis|@azure\/|node-vault|hashicorp|vault-client|pkcs11|graphene-pk11|@peculiar|yubihsm|cloudkms/i;

describe('CORE-02 — the rules below measure real sources', () => {
  it('every measured root has sources', () => {
    for (const root of [...CORE_ROOTS, EXTERNAL_ROOT]) assert.ok(sourceFiles(root).length > 0, root);
    assert.ok(EXTERNAL_CLIENT.length >= 4);
  });
});

describe('CORE-02 — CORE imports no KMS/HSM vendor SDK and speaks no provider vocabulary', () => {
  it('no vendor SDK is imported by CORE, the stores, the authenticity module or the external signer module — and none is a dependency', () => {
    for (const root of [...CORE_ROOTS, EXTERNAL_ROOT]) {
      for (const file of sourceFiles(root)) {
        for (const specifier of importsOf(file)) assert.equal(VENDOR_SDK.test(specifier), false, `${file} imports '${specifier}'`);
      }
    }
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.equal(VENDOR_SDK.test(name), false, `package.json depends on ${name}`);
  });

  it('the Kernel, the governed runtimes and the stores carry no provider key vocabulary (ARNs, KMS key paths, vault transit)', () => {
    const vocabulary = /\barn:aws\b|\bkms\b|cloudkms|keyvault|key vault|vault transit|\bhsm\b|projects\/[^/]+\/locations/i;
    for (const root of CORE_ROOTS) {
      for (const file of sourceFiles(root)) assert.equal(vocabulary.test(codeOf(file)), false, `${file} must not name a key provider`);
    }
  });

  it('nothing in CORE knows how signatures are transported: only the enterprise composition edge imports the external signer module', () => {
    for (const root of CORE_ROOTS) {
      for (const file of sourceFiles(root)) {
        for (const specifier of importsOf(file)) assert.equal(/external-authority-signer/.test(specifier), false, `${file} must not import the external signer module`);
        assert.equal(/node:http\b|node:https\b|fetch\(/.test(codeOf(file)) && root.startsWith('src/enterprise/authority-authenticity'), false, `${file}: the authenticity module does no network I/O`);
      }
    }
  });
});

describe('CORE-02 — the custody boundary stays structured: no generic signing, no key export', () => {
  it('no operation in the client, the transport or the protocol signs caller-chosen bytes', () => {
    for (const file of EXTERNAL_CLIENT) {
      const code = codeOf(file);
      assert.equal(/\b(sign|signBytes|signDigest|signPayload|signRaw|cryptoSign)\s*\(\s*(bytes|data|payload|digest|buffer|message)\b/.test(code), false, `${file}: no generic signing call`);
      assert.equal(/\b(sign|signBytes|signDigest|signPayload|signRaw)\s*\([^)]*:\s*(Buffer|Uint8Array|string)\s*[,)]/.test(code), false, `${file}: no signing method takes raw bytes or a string`);
      assert.equal(/'\/(v1\/)?sign'/.test(code), false, `${file}: no generic /sign route`);
    }
    const transport = codeOf(`${EXTERNAL_ROOT}/transport.ts`);
    const port = block(transport, 'export interface ExternalAuthoritySignerTransport');
    assert.match(port, /sign\(request: ExternalAuthoritySigningRequest,/, 'the transport signs structured requests only');
    assert.deepEqual([...port.matchAll(/^\s+(\w+)\(/gm)].map((match) => match[1]).sort(), ['identity', 'sign']);
  });

  it('no private key crosses the boundary in either direction: no key-export operation, no private-key parsing, no private-key field in the client', () => {
    const forbidden = /exportPrivateKey|getPrivateKey|backupPrivateKey|returnSecretKey|secretKey|privateKeyPem|createPrivateKey|createSoftwareAuthorityArtifactSigner|generateKeyPair/;
    for (const file of EXTERNAL_CLIENT) assert.equal(forbidden.test(codeOf(file)), false, `${file} must hold no private key`);
    // The reference service owns a key; it never answers with it.
    const reference = codeOf(`${EXTERNAL_ROOT}/reference/reference-signer-service.ts`);
    const identity = block(reference, 'const identity = Object.freeze(');
    assert.equal(/privateKeyPem/.test(identity), false, 'the identity answer carries public material only');
    assert.equal(/send\(res,\s*200,\s*[^)]*privateKey/.test(reference), false, 'no route answers with key material');
    assert.equal(/export|backup|\/keys?\b/i.test(reference.slice(reference.indexOf('function handle(')).split('\n').filter((line) => line.includes("path ===")).join('\n')), false);
  });

  it('every returned signature is verified locally, under the pinned key, before it is returned to a store', () => {
    const adapter = codeOf(`${EXTERNAL_ROOT}/external-signer.ts`);
    const accept = block(adapter, 'function accept(');
    assert.ok(accept.includes('verifyLocally(request, signature)'), 'accept verifies');
    assert.ok(/!verification\.verified \|\| verification\.keyId !== pinned\.keyId/.test(accept), 'under the pinned key, not merely a trusted one');
    assert.ok(/envelope\.keyId !== pinned\.keyId/.test(accept) && /envelope\.algorithm !== pinned\.algorithm/.test(accept));
    const sign = block(adapter, 'async function sign(');
    assert.ok(sign.indexOf('accept(request, answer)') !== -1 && sign.indexOf('return signature') > sign.indexOf('accept(request, answer)'), 'nothing is returned that accept() did not approve');
    assert.equal(/isRetryableAuthoritySigningFailure\(reason\)/.test(sign), true, 'only the availability family is retried');
  });

  it('the handshake compares the advertised public key with the pinned one — it never adds or trusts it', () => {
    const adapter = codeOf(`${EXTERNAL_ROOT}/external-signer.ts`);
    const check = block(adapter, 'function checkIdentity(');
    assert.ok(check.includes('advertised.equals(pinnedSpki)'));
    assert.equal(/createAuthorityArtifactVerifier|trustedKeyIds\.push|registry\.set|verificationKeys\.push/.test(adapter), false, 'remote material never enters a trust registry');
  });
});

describe('CORE-02 — the external composition path cannot reach a private key and cannot fall back', () => {
  it('buildAuthorityAuthenticity: the external branch returns before any private-key parsing, and has no fallback', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    const build = block(root, 'async function buildAuthorityAuthenticity(');
    const externalReturn = build.indexOf("return { signer, verifier, custody: 'external', monitor }");
    assert.ok(externalReturn !== -1, 'the external branch returns its own signer');
    for (const software of ['createSoftwareAuthorityArtifactSigner(', 'authorityVerificationKeyFromPrivateKey(', 'const signingKeyPem']) {
      assert.ok(build.indexOf(software) > externalReturn, `${software} is reachable only after the external branch has returned`);
    }
    const externalBranch = build.slice(build.lastIndexOf("if (authenticity.mode === 'external') {", externalReturn), externalReturn);
    assert.ok(externalBranch.length > 0);
    assert.equal(/catch|signingKeyPem|createPrivateKey|Software/.test(externalBranch), false, 'no fallback and no key in the external branch');
    // The contradiction is refused before anything else happens.
    assert.ok(build.indexOf('conflictingSigningKeyPresent') < build.indexOf('establishExternalAuthorityArtifactSigner('));
  });

  it('the external configuration never reads the private-key variable’s value — only whether it is present', () => {
    const config = codeOf('src/enterprise/configuration/enterprise-configuration.ts');
    const load = block(config, 'function loadAuthorityAuthenticity(');
    const external = block(load, "if (env.AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE === 'external')");
    const mentions = [...external.matchAll(/env\.AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM([^\n]{0,20})/g)].map((match) => match[1]?.trim());
    assert.deepEqual(mentions, ['!== undefined,'], 'a presence check, never the value');
    const type = block(config, 'export interface ExternalAuthorityAuthenticityConfiguration');
    assert.equal(/signingKeyPem|privateKey/i.test(type), false, 'the external variant has no private-key field');
  });

  it('the Host refuses an external configuration whose composed signer is not external, in every profile', () => {
    const host = codeOf('src/enterprise/host/enterprise-host.ts');
    assert.match(host, /authorityAuthenticity\.mode === 'external' && posture\.authorityStore !== 'not-composed' && posture\.authoritySigner !== 'external'/);
  });
});

describe('CORE-02 / TD-5 — the authority key is never a passport key', () => {
  it('the authority signer exposes no passport, identity or generic operation', () => {
    const signer = codeOf('src/enterprise/authority-authenticity/signer.ts');
    const iface = block(signer, 'export interface AuthorityArtifactSigner');
    assert.equal(/passport|identity|credential|seal/i.test(iface), false);
    assert.deepEqual([...iface.matchAll(/^\s+(sign\w*)\(/gm)].map((match) => match[1]).sort(), ['signApprovalState', 'signGrant', 'signObligationDischargeState', 'signRevocation', 'signRevocationState']);
  });

  it('the Enterprise Host composes no Agent Passport signer — the HMAC test signer lives only in the standalone passport app', () => {
    for (const file of sourceFiles('src/enterprise')) {
      const code = codeOf(file);
      assert.equal(/createTestSigner|AgentPassportSignerPort|createHmac/.test(code), false, `${file} must not compose a passport (or any HMAC) signer`);
    }
    // The one place it is used is the separate Next.js app, which this Host does not compose.
    assert.ok(readFileSync('apps/agent-passport-web/src/lib/issuer/issuer-signer.ts', 'utf8').includes('createTestSigner'));
  });
});
