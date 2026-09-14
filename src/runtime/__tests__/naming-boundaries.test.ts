import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Pins the two naming boundaries recorded as TB-003 and TB-004 in
 * `docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md`.
 *
 * Both modules carry security-suggestive names — `crypto/`, `verify*`, `vault`,
 * `attestation` — whose implementations provide none of what those words imply.
 * Prompt 2 resolved that with documentation rather than a rename, because both
 * symbols reach the checksum-pinned public surface (`release/RELEASE_MANIFEST.json`)
 * and renaming would be a consumer-breaking change for no behavioural gain.
 *
 * Documentation alone rots. These assertions make the claim machine-checked **in
 * both directions**: the modules must stay free of cryptographic primitives, so
 * the notices cannot quietly become wrong — and if someone later adds real
 * verification or real key custody, this suite fails and forces the
 * documentation to be corrected along with the code.
 *
 * This is not a containment feature and asserts no weakness. It asserts that a
 * *name* and an *implementation* have not silently diverged further.
 */

const CRYPTO_MODULE = 'src/runtime/crypto';
const VAULT_MODULE = 'src/runtime/vault';

/** Primitives whose presence would mean the name had become accurate — or that the docs had gone stale. */
const CRYPTOGRAPHIC_PRIMITIVES: readonly RegExp[] = [
  /from ['"]node:crypto['"]/,
  /from ['"]crypto['"]/,
  /\bcreateHash\s*\(/,
  /\bcreateHmac\s*\(/,
  /\bcreateVerify\s*\(/,
  /\bcreateSign\s*\(/,
  /\btimingSafeEqual\s*\(/,
  /\bsubtle\s*\./,
  /\bjose\b/,
  /\bjsonwebtoken\b/,
];

/** External key-custody services. Their absence is the whole of TB-004's point. */
const KEY_CUSTODY_DEPENDENCIES: readonly RegExp[] = [/\bKMS\b/, /\bHSM\b/, /aws-sdk/, /@aws-sdk/, /keyvault/i, /\bhashicorp\b/i];

function sourceFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'tests') continue;
      out.push(...sourceFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Required here, not optional: both modules' new headers deliberately spell out
 * the words `createHash`, `KMS` and `HSM` in order to say that none of them is
 * used. A rule applied to raw text would fail on its own explanation.
 */
function codeOf(file: string): string {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
  return text
    .split('\n')
    .map((line) => {
      let quote: string | undefined;
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const previous = index > 0 ? line[index - 1] : '';
        if (quote !== undefined) {
          if (char === quote && previous !== '\\') quote = undefined;
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

describe('TB-003 — the crypto-named verifier performs no cryptographic verification', () => {
  const sources = sourceFiles(CRYPTO_MODULE);

  it('has sources to measure', () => {
    assert.ok(sources.length >= 3, `expected ${CRYPTO_MODULE} to have sources, found ${sources.length}`);
  });

  it('the comment stripper drops the explanation but keeps the code', () => {
    const verifier = codeOf('src/runtime/crypto/verification/capability-verifier.ts');
    assert.equal(verifier.includes('export function verifyCapabilityToken'), true, 'real code must survive stripping');
    assert.equal(verifier.includes('NO cryptographic verification'), false, 'the doc header must be stripped, or the rules below would fail on their own prose');
  });

  it('imports and calls no cryptographic primitive', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of CRYPTOGRAPHIC_PRIMITIVES) {
        assert.equal(
          pattern.test(code),
          false,
          `${file} now uses ${String(pattern)} — the module's documented "no cryptographic verification" boundary (TB-003) must be updated with it`,
        );
      }
    }
  });
});

describe('TB-004 — the vault is not a cryptographic or key vault', () => {
  const sources = sourceFiles(VAULT_MODULE);

  it('has sources to measure', () => {
    assert.ok(sources.length >= 5, `expected ${VAULT_MODULE} to have sources, found ${sources.length}`);
  });

  it('imports and calls no cryptographic primitive', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of CRYPTOGRAPHIC_PRIMITIVES) {
        assert.equal(
          pattern.test(code),
          false,
          `${file} now uses ${String(pattern)} — TB-004 records this module as performing no cryptography, and that record must be updated with it`,
        );
      }
    }
  });

  it('reaches no external key-custody service', () => {
    for (const file of sources) {
      const code = codeOf(file);
      for (const pattern of KEY_CUSTODY_DEPENDENCIES) {
        assert.equal(pattern.test(code), false, `${file} now reaches a key-custody dependency (${String(pattern)}); TB-004 states this module holds no keys`);
      }
    }
  });

  it('the attestation remains a label rather than a digest, or the record is updated', () => {
    // `createRuntimeVaultAttestation` joins identifiers with ':'. Calling that an
    // "attestation" is the overclaim TB-004 exists to bound. If it ever becomes a
    // real digest or signature, this fails and the finding must be revisited.
    const attestation = codeOf('src/runtime/vault/runtime-vault-attestation.ts');
    assert.ok(/parts\.join\(/.test(attestation), 'the attestation builder changed shape — re-assess TB-004 before updating this test');
  });
});

describe('Signing material stays out of the authorization layers', () => {
  const AUTHORIZATION_LAYERS = ['src/kernel', 'src/features/grant-runtime', 'src/features/execution-runtime'];

  it('no authorization layer imports the Agent Passport issuer or any signer factory', () => {
    const forbidden = [/@aoc-enterprise\/agent-governance/, /issuer-signer/, /\bcreateTestSigner\b/, /passport-issuer/];
    for (const root of AUTHORIZATION_LAYERS) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, 'utf8');
        for (const pattern of forbidden) {
          assert.equal(
            pattern.test(text),
            false,
            `${file} reaches signing material (${String(pattern)}) — the decision and grant layers hold no key and must not acquire one`,
          );
        }
      }
    }
  });
});
