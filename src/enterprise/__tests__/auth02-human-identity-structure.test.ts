import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * AUTH-02 structure — the boundaries of the human identity module, asserted
 * over its source: identity is not authority, nothing is reachable over HTTP,
 * no private key material is handled, and the WebAuthn library is loaded
 * lazily from exactly one place.
 */

const MODULE = 'src/enterprise/human-identity';
const files = readdirSync(MODULE)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => `${MODULE}/${name}`);
const read = (file: string): string => readFileSync(file, 'utf8');
/** Source with comments removed, so prose describing a boundary never trips it. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');

describe('AUTH-02 structure — the human identity module', () => {
  it('is the module the tests expect', () => {
    assert.deepEqual(files.map((file) => file.slice(MODULE.length + 1)).sort(), ['chain.ts', 'contracts.ts', 'index.ts', 'relying-party.ts', 'service.ts', 'sqlite-human-identity-store.ts', 'webauthn.ts']);
  });

  it('imports only node builtins, its own files, better-sqlite3, the WebAuthn library and the operator principal type', () => {
    for (const file of files) {
      for (const [, specifier] of code(file).matchAll(/(?:from|import\()\s*'([^']+)'/g)) {
        const allowed =
          specifier!.startsWith('node:') ||
          specifier!.startsWith('./') ||
          specifier === 'better-sqlite3' ||
          specifier === '@simplewebauthn/server' ||
          specifier === '@simplewebauthn/server/helpers' ||
          specifier === '../operator-control/operator-authenticator.js';
        assert.ok(allowed, `${file} imports '${specifier!}'`);
      }
    }
    const service = code(`${MODULE}/service.ts`);
    assert.match(service, /^import type \{ EnterpriseOperatorPrincipal \} from '\.\.\/operator-control\/operator-authenticator\.js';$/m, 'the operator principal is imported as a type only');
  });

  it('identity is not authority: no approval, Kernel-Authority, grant, capability or execution concept is reached', () => {
    for (const file of files) {
      assert.equal(/approval-authority|kernel-authority|execution-capability|governed-action|bounded-grant|ApprovalCommand|approve\(/.test(code(file)), false, file);
      assert.equal(/authenticated:\s*true/.test(code(file)), false, `${file} builds no trusted command context`);
    }
  });

  it('nothing is reachable over HTTP: no network module here, and no route or composition names the module', () => {
    for (const file of files) assert.equal(/'node:(?:http|https|net|tls|dgram|http2)'|fetch\(/.test(code(file)), false, file);
    for (const surface of ['src/enterprise/adapters/node-http-adapter.ts', 'src/enterprise/composition/composition-root.ts', 'src/enterprise/host/enterprise-host.ts', 'src/control-plane-web']) {
      const sources = surface.endsWith('.ts') ? [surface] : readdirSync(surface, { recursive: true }).map(String).filter((name) => name.endsWith('.ts') || name.endsWith('.tsx')).map((name) => `${surface}/${name}`);
      for (const file of sources) assert.equal(/human-identity/.test(read(file)), false, `${file} must not expose human identity in AUTH-02`);
    }
  });

  it('handles no private key material: it never generates, imports, exports or uses a private key, and never signs', () => {
    for (const file of files) {
      assert.equal(/createPrivateKey|generateKeyPair|privateKey|pkcs8|\bsign\(|createSign/.test(code(file)), false, file);
    }
  });

  it('loads the WebAuthn library lazily, from webauthn.ts alone', () => {
    for (const file of files) {
      const text = code(file);
      assert.equal(/from\s+'@simplewebauthn\//.test(text), false, `${file} must not import the library statically`);
      if (!file.endsWith('/webauthn.ts')) assert.equal(/@simplewebauthn/.test(text.replace(/typeof import\('@simplewebauthn[^']*'\)/g, '')), false, file);
    }
    assert.match(code(`${MODULE}/webauthn.ts`), /import\('@simplewebauthn\/server'\)/);
  });

  it('pins the WebAuthn dependency exactly', () => {
    const pkg = JSON.parse(read('package.json')) as { readonly dependencies: Readonly<Record<string, string>> };
    assert.equal(pkg.dependencies['@simplewebauthn/server'], '14.0.3');
  });
});
