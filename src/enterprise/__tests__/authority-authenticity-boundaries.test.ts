import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadEnterpriseConfiguration, toPublicEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { AUTHORITY_KEY_A, testSigner, testVerifier } from './authority-authenticity-fixture.js';

/**
 * The structural half of Prompt 5: rules a future change cannot quietly undo.
 *
 * The behavioural suite proves the cryptography works. These prove the things
 * that stop it *mattering less over time* — that the exercise path never gains a
 * signer, that no unsigned path is reintroduced "temporarily", that trust keeps
 * coming from configuration rather than from artifacts, and that the private key
 * never reaches a surface designed to be published.
 *
 * Every rule is measured against source or behaviour, never a line number.
 */

const AUTHENTICITY_ROOT = 'src/enterprise/authority-authenticity';
const GRANT_STORE_ROOT = 'src/enterprise/bounded-grant-store';
const EXECUTION_RUNTIME_ROOT = 'src/features/execution-runtime';
const GRANT_RUNTIME_ROOT = 'src/features/grant-runtime';
/**
 * Governed-execution subsystems on current main that post-date the historical
 * authenticity change: exercise controls, monetary classification, emergency
 * control, outcomes, reconciliation, resolution, adapters, governed actions,
 * the authority event stream and the issuance/execution service itself. The
 * signer lives sealed inside the durable store; none of these may name it.
 */
const GOVERNED_EXECUTION_ROOTS = [
  'src/features/exercise-control-runtime',
  'src/features/monetary-runtime',
  'src/features/emergency-control-runtime',
  'src/enterprise/execution-governance',
  'src/enterprise/execution-adapters',
  'src/enterprise/execution-outcome-store',
  'src/enterprise/execution-reconciliation',
  'src/enterprise/execution-resolution-store',
  'src/enterprise/exercise-control-ledger',
  'src/enterprise/governed-action',
  'src/enterprise/authority-event-stream',
] as const;

function sourceFiles(dir: string, includeTests = false): readonly string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!includeTests && (name === 'tests' || name === '__tests__')) continue;
      out.push(...sourceFiles(full, includeTests));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** A source file with its comments removed, so a rule measures what executes rather than what is explained. */
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

const AUTHENTICITY_SOURCES = sourceFiles(AUTHENTICITY_ROOT);
const EXECUTION_SOURCES = sourceFiles(EXECUTION_RUNTIME_ROOT);
const GRANT_SOURCES = sourceFiles(GRANT_RUNTIME_ROOT);
const STORE_SOURCES = sourceFiles(GRANT_STORE_ROOT);

describe('Authority authenticity — the rules below are not vacuous', () => {
  it('there are real production sources to measure', () => {
    assert.ok(AUTHENTICITY_SOURCES.length >= 4, `expected sources under ${AUTHENTICITY_ROOT}, found ${AUTHENTICITY_SOURCES.length}`);
    assert.ok(EXECUTION_SOURCES.length >= 5);
    assert.ok(STORE_SOURCES.length >= 3);
  });

  it('the comment stripper keeps code and drops prose', () => {
    const verifier = codeOf(`${AUTHENTICITY_ROOT}/verifier.ts`);
    assert.ok(verifier.includes('export function createAuthorityArtifactVerifier'), 'real code must survive stripping');
    assert.equal(verifier.includes('Trust comes from the registry'), false, 'doc-comment prose must be stripped');
  });
});

describe('Authority authenticity — signing capability never reaches the exercise path', () => {
  it('the execution runtime names no signer, no signing key and no crypto primitive', () => {
    const forbidden = [
      /AuthorityArtifactSigner/,
      /createSoftwareAuthorityArtifactSigner/,
      /signGrant/,
      /signRevocation/,
      /privateKey/i,
      /authority-authenticity/,
      /from ['"]node:crypto['"]/,
    ];
    for (const file of EXECUTION_SOURCES) {
      const code = codeOf(file);
      for (const pattern of forbidden) {
        assert.equal(pattern.test(code), false, `${file} must not reach signing capability (${pattern})`);
      }
    }
  });

  it('no governed-execution subsystem added since the historical change reaches signing capability either', () => {
    // Forward-port coverage. These consume, exercise, pay against or reconcile
    // authority; none of them may be able to mint it. `node:crypto` is not
    // forbidden here, because several legitimately compute unkeyed digests —
    // what is forbidden is every name through which a private authority key
    // or a signer could arrive.
    const forbidden = /AuthorityArtifactSigner|createSoftwareAuthorityArtifactSigner|signGrant|signRevocation|signingKeyPem|privateKeyPem|createPrivateKey|authority-authenticity/;
    let measured = 0;
    for (const root of GOVERNED_EXECUTION_ROOTS) {
      const files = sourceFiles(root);
      assert.ok(files.length > 0, `expected production sources under ${root}`);
      for (const file of files) {
        measured += 1;
        assert.equal(forbidden.test(codeOf(file)), false, `${file} must not reach signing capability`);
      }
    }
    assert.ok(measured >= 50, `expected to measure the governed-execution subsystems, measured ${measured} files`);
  });

  it('the grant runtime — layer E — holds no signer and no key material either', () => {
    for (const file of GRANT_SOURCES) {
      const code = codeOf(file);
      assert.equal(/AuthorityArtifactSigner|createSoftwareAuthorityArtifactSigner|privateKeyPem/.test(code), false, `${file} must not hold signing capability`);
    }
  });

  it('the exercise path reads through a port with exactly one method, and it is not a signing one', async () => {
    const port = readFileSync(`${GRANT_RUNTIME_ROOT}/domain/grant-store-port.ts`, 'utf8');
    const reader = port.slice(port.indexOf('export interface BoundedGrantReaderPort'));
    const body = reader.slice(0, reader.indexOf('}') + 1);
    assert.ok(body.includes('read('), 'the reader port must expose the authoritative read');
    assert.equal(/sign|issue\(|revoke\(/.test(body), false, 'the reader port must expose nothing but the read');
  });
});

describe('Authority authenticity — signer and verifier are distinct capabilities', () => {
  it('the verifier module never imports, derives or returns private key material', () => {
    const verifier = codeOf(`${AUTHENTICITY_ROOT}/verifier.ts`);
    assert.equal(/createPrivateKey|privateKeyPem|crypto\.sign\b|[^a-zA-Z]sign\(/.test(verifier), false, 'the verifier must hold only public material');
    assert.ok(verifier.includes('createPublicKey'), 'the verifier resolves public material');
  });

  it('createPrivateKey appears in exactly one production file, and it is the signer', () => {
    const holders = AUTHENTICITY_SOURCES.filter((file) => /createPrivateKey/.test(codeOf(file)));
    assert.deepEqual(holders, [`${AUTHENTICITY_ROOT}/signer.ts`], `private key material must be confined to the signer, found in ${holders.join(', ')}`);
  });

  it('the two interfaces are declared separately, and neither extends the other', () => {
    const signer = readFileSync(`${AUTHENTICITY_ROOT}/signer.ts`, 'utf8');
    const verifier = readFileSync(`${AUTHENTICITY_ROOT}/verifier.ts`, 'utf8');
    assert.ok(signer.includes('export interface AuthorityArtifactSigner'));
    assert.ok(verifier.includes('export interface AuthorityArtifactVerifier'));
    assert.equal(/interface AuthorityArtifactVerifier extends/.test(verifier), false);
    assert.equal(/interface AuthorityArtifactSigner extends/.test(signer), false);
  });

  it('a constructed verifier has no signing member at runtime, and a constructed signer no key member', () => {
    const verifier = testVerifier();
    const signer = testSigner();
    assert.deepEqual(Object.keys(verifier).sort(), ['trustedKeyIds', 'verifyGrant', 'verifyRevocation']);
    assert.deepEqual(Object.keys(signer).sort(), ['activeKeyId', 'algorithm', 'signGrant', 'signRevocation']);
  });

  it('the signer offers no generic "sign arbitrary bytes" capability', () => {
    const signer = readFileSync(`${AUTHENTICITY_ROOT}/signer.ts`, 'utf8');
    const iface = signer.slice(signer.indexOf('export interface AuthorityArtifactSigner'));
    const body = iface.slice(0, iface.indexOf('}') + 1);
    assert.equal(/\bsign\s*\(/.test(body), false, 'a domain-aware signer must not expose a raw byte-signing operation');
    assert.ok(body.includes('signGrant') && body.includes('signRevocation'));
  });
});

describe('Authority authenticity — trust comes from configuration, never from artifacts', () => {
  it('no verification path reads a public key out of the artifact or the signature envelope', () => {
    for (const file of [...AUTHENTICITY_SOURCES, ...STORE_SOURCES]) {
      const code = codeOf(file);
      assert.equal(/signature\.publicKey|artifact\.publicKey|row\.public_key|candidate\.publicKey/.test(code), false, `${file} must not treat artifact-supplied key material as a trust root`);
    }
  });

  it('the signature envelope type has no field a public key could travel in', () => {
    const source = readFileSync(`${AUTHENTICITY_ROOT}/authority-signature.ts`, 'utf8');
    const iface = source.slice(source.indexOf('export interface AuthoritySignature'));
    const body = iface.slice(0, iface.indexOf('}') + 1);
    assert.equal(/publicKey|certificate|jwk|x5c/i.test(body), false, 'the envelope must carry a key *claim*, never key material');
  });

  it('there is no network key discovery — no JWKS, no fetch, no remote lookup', () => {
    for (const file of [...AUTHENTICITY_SOURCES, ...STORE_SOURCES]) {
      const code = codeOf(file);
      assert.equal(/jwks|fetch\(|https?:\/\/|node:https|node:http\b/i.test(code), false, `${file} must resolve keys locally`);
    }
  });

  it('the registry is built from composition-supplied entries and frozen against later mutation', () => {
    const verifier = testVerifier();
    assert.ok(Object.isFrozen(verifier), 'the verifier must be frozen');
    assert.throws(() => {
      (verifier.trustedKeyIds as string[]).push('injected-key');
    }, 'the trusted key list must not be extensible at runtime');
  });
});

describe('Authority authenticity — no unsigned path exists', () => {
  it('the durable store requires an authenticity boundary, with no default and no optional marker', () => {
    const store = readFileSync(`${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`, 'utf8');
    assert.equal(/options:\s*CreateSqliteBoundedGrantStoreOptions\s*=/.test(store), false, 'store options must have no default — a forgotten boundary must not compile');
    assert.equal(/authenticity\?:/.test(store), false, 'the authenticity boundary must not be optional');
    assert.ok(/readonly authenticity:\s*\{/.test(store), 'the authenticity boundary must be a required field');
  });

  it('no configuration flag can switch authenticity off', () => {
    const config = codeOf('src/enterprise/configuration/enterprise-configuration.ts');
    const section = config.slice(config.indexOf('readonly authorityAuthenticity'));
    const body = section.slice(0, section.indexOf('};') + 2);
    assert.equal(/enabled|disabled|required:\s*boolean|allowUnsigned|skipVerification/.test(body), false, 'authenticity must not be expressible as a feature flag');
  });

  it('the store verifies on every authoritative read, with no branch that skips it', () => {
    const code = codeOf(`${GRANT_STORE_ROOT}/sqlite-bounded-grant-store.ts`);
    // Both verification calls are unconditional inside their helper, and both
    // helpers throw on failure. A `verified === true` branch with no else, or a
    // verification inside an `if`, would be the shape to catch.
    for (const call of ['verifier.verifyGrant(', 'verifier.verifyRevocation(']) {
      assert.ok(code.includes(call), `${call} must be present`);
      assert.equal(code.split(call).length - 1, 1, `${call} must appear exactly once — one verification point, not several to keep in step`);
    }
    assert.equal(code.split('if (!verification.verified) throw').length - 1, 2, 'every verification must throw on failure');
  });

  it('no bounded-grant authority path uses an HMAC or any shared-secret construction', () => {
    for (const file of [...AUTHENTICITY_SOURCES, ...STORE_SOURCES, ...GRANT_SOURCES]) {
      const code = codeOf(file);
      assert.equal(/createHmac|hmac|sharedSecret|secretKey/i.test(code), false, `${file} must not authenticate authority against a shared secret`);
    }
  });

  it('the supported-algorithm registry is closed, and nothing tries algorithms until one works', () => {
    const code = codeOf(`${AUTHENTICITY_ROOT}/verifier.ts`);
    assert.equal(/for\s*\(.*algorithm/i.test(code), false, 'a verifier must not iterate algorithms');
    assert.equal(/catch[\s\S]{0,120}verify\(/.test(code.replace(/\n/g, ' ')), false, 'a failed verification must not be retried under another algorithm');
  });
});

describe('Authority authenticity — the private key never reaches a public surface', () => {
  it('the redacted configuration carries no signing key, under any key name', () => {
    const configuration = {
      ...loadEnterpriseConfiguration({}),
      authorityAuthenticity: {
        activeSigningKeyId: AUTHORITY_KEY_A.keyId,
        signingKeyPem: AUTHORITY_KEY_A.privateKeyPem,
        verificationKeys: [{ keyId: AUTHORITY_KEY_A.keyId, algorithm: 'ed25519-v1', publicKeyPem: AUTHORITY_KEY_A.publicKeyPem }],
      },
    };

    const published = JSON.stringify(toPublicEnterpriseConfiguration(configuration));
    assert.equal(published.includes('PRIVATE KEY'), false, 'the public configuration must never carry private key material');
    assert.equal(published.includes(AUTHORITY_KEY_A.privateKeyPem.replace(/\n/g, '\\n')), false);
    assert.equal(published.includes('signingKeyPem'), false, 'the field itself must not survive redaction');
    // The public half and the key id stay: they are public material, and an
    // operator diagnosing a rotation needs them.
    assert.ok(published.includes(AUTHORITY_KEY_A.keyId));
  });

  it('the public configuration type has no property a private key could be assigned to', () => {
    // Measured with comments stripped: the doc comment on this type *names*
    // `signingKeyPem` in order to say it is absent, and a rule that could not
    // tell the difference between saying so and declaring it would be checking
    // the prose.
    const config = codeOf('src/enterprise/configuration/enterprise-configuration.ts');
    const type = config.slice(config.indexOf('export type PublicEnterpriseConfiguration'));
    const body = type.slice(0, type.indexOf('\n};') + 3);
    assert.equal(/signingKeyPem/.test(body), false, 'the public configuration type must not declare the signing key at all');
    assert.ok(/signingKeyConfigured/.test(body), 'a non-secret presence flag is what a diagnostic surface gets instead');
  });

  it('no authority signing key is written into any persisted authority record', () => {
    for (const file of STORE_SOURCES) {
      const code = codeOf(file);
      assert.equal(/privateKey|signingKeyPem|PRIVATE KEY/.test(code), false, `${file} must never persist key material`);
    }
  });

  it('nothing in the authenticity module logs', () => {
    for (const file of AUTHENTICITY_SOURCES) {
      const code = codeOf(file);
      assert.equal(/console\.|logger\.|process\.stdout|process\.stderr/.test(code), false, `${file} must not log — key material and signed payloads must never reach a log`);
    }
  });
});

describe('Authority authenticity — composition wires the two halves separately', () => {
  it('the composition root builds a signer and a verifier as separate constructions', () => {
    const root = codeOf('src/enterprise/composition/composition-root.ts');
    assert.ok(root.includes('createSoftwareAuthorityArtifactSigner('), 'the signer is constructed at the composition boundary');
    assert.ok(root.includes('createAuthorityArtifactVerifier('), 'the verifier is constructed at the composition boundary');
  });

  it('a durable store selected without configured keys is refused, not silently downgraded', async () => {
    const { createEnterprise } = await import('../composition/composition-root.js');
    const { buildTestKernelProviders } = await import('./support.js');
    const { KernelGrantCapability } = await import('../../kernel/orchestration/grant-adapter.js');
    const { createRecordingExecutionAdapter } = await import('../../features/execution-runtime/tests/execution-fixture.js');

    const configuration = {
      ...loadEnterpriseConfiguration({}),
      persistence: { ...loadEnterpriseConfiguration({}).persistence, provider: 'sqlite' as const },
    };

    await assert.rejects(
      () =>
        createEnterprise({
          configuration,
          kernelProviders: buildTestKernelProviders(),
          authorityControlledExecution: {
            grantCapability: new KernelGrantCapability({ declaration: {} }),
            executionAdapter: createRecordingExecutionAdapter(),
            resolveAuthorityBinding: () => ({ kind: 'no-temporal-authority-bound', sourceKind: 'none-applicable', justification: 'test composition' }),
          },
        }),
      (error: unknown) => error instanceof Error && /authority signing key/i.test(error.message),
      'durable authority without a key boundary must be refused at composition',
    );
  });
});
