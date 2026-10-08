import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AOC_KERNEL_VERSION } from '../../kernel/index.js';
import { loadEnterpriseConfiguration } from '../configuration/enterprise-configuration.js';
import { createEnterpriseServer } from '../host/enterprise-server.js';
import { RELEASE_IDENTITY_SCHEMA, ReleaseIdentityError, developmentReleaseIdentity, parseReleaseIdentity, readReleaseIdentity } from '../host/release-identity.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';

/**
 * PROD-03-03 — the release identity a deployed Host reports (`GET /version`).
 *
 * Fixed at build time, validated against the code it ships with, never set by
 * configuration, and honest when nothing was recorded.
 */

const PKG = { name: '@aoc-enterprise/runtime', version: '9.8.7' } as const;
const COMMIT = 'a'.repeat(40);

function recorded(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: RELEASE_IDENTITY_SCHEMA,
    product: 'frontera',
    package: PKG.name,
    version: PKG.version,
    commit: COMMIT,
    release: `${PKG.version}+${COMMIT.slice(0, 12)}`,
    build: 'release',
    api: { surface: 'aoc-enterprise-host-http.v1', endpointCount: 65 },
    runtimeVersions: { enterpriseHost: AOC_ENTERPRISE_HOST_VERSION, kernel: AOC_KERNEL_VERSION },
    storeSchemaVersions: { governance: 'aoc.governance-store.schema.v1' },
    canonicalizationVersion: 'aoc.canonical-json.v1',
    node: { supported: '>=22' },
    ...overrides,
  };
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function artifactRoot(identity?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'frontera-release-identity-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(PKG));
  if (identity !== undefined) {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'release-identity.json'), typeof identity === 'string' ? identity : JSON.stringify(identity));
  }
  return root;
}

describe('PROD-03-03 release identity', () => {
  it('a recorded release build is read back exactly, with the running Node version added', () => {
    const identity = readReleaseIdentity(artifactRoot(recorded()));
    assert.equal(identity.build, 'release');
    assert.equal(identity.commit, COMMIT);
    assert.equal(identity.release, '9.8.7+aaaaaaaaaaaa');
    assert.equal(identity.api.endpointCount, 65);
    assert.equal(identity.node.running, process.version);
  });

  it('a build that recorded nothing says so: development, commit unknown, never a guess', () => {
    const identity = readReleaseIdentity(artifactRoot());
    assert.deepEqual(identity, developmentReleaseIdentity(PKG));
    assert.equal(identity.build, 'development');
    assert.equal(identity.commit, 'unknown');
    assert.equal(identity.release, '9.8.7+development');
  });

  it('refuses an identity that does not describe the code it ships with', () => {
    const cases: Record<string, unknown> = {
      'another package version': recorded({ version: '1.0.0' }),
      'another package': recorded({ package: '@other/runtime' }),
      'a short commit': recorded({ commit: 'abc123' }),
      'a release without a commit': recorded({ commit: 'unknown' }),
      'a release string that is not derived': recorded({ release: '9.8.7' }),
      'another Kernel version': recorded({ runtimeVersions: { enterpriseHost: AOC_ENTERPRISE_HOST_VERSION, kernel: '0.0.1' } }),
      'another API surface': recorded({ api: { surface: 'something-else', endpointCount: 65 } }),
      'an unknown build kind': recorded({ build: 'nightly' }),
      'another schema': recorded({ schema: 'frontera.release-identity.v0' }),
      'a store schema with prose in it': recorded({ storeSchemaVersions: { governance: 'see the release notes' } }),
    };
    for (const [label, value] of Object.entries(cases)) {
      assert.throws(() => parseReleaseIdentity(value, PKG), ReleaseIdentityError, label);
    }
    assert.throws(() => readReleaseIdentity(artifactRoot('{ not json')), ReleaseIdentityError);
  });

  it('GET /version serves the identity of this build: public metadata only, no configuration', async () => {
    const server = await createEnterpriseServer({
      configuration: loadEnterpriseConfiguration({ AOC_ENTERPRISE_HTTP_PORT: '0', AOC_ENTERPRISE_HTTP_HOST: '127.0.0.1', AOC_ENTERPRISE_LOG_LEVEL: 'error', AOC_ENTERPRISE_API_KEYS: 'PROD0303VERSIONCANARYKEY000000000000' }),
    });
    try {
      const { port } = await server.listen();
      const response = await fetch(`http://127.0.0.1:${port}/version`);
      assert.equal(response.status, 200);
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
      assert.equal(body['product'], 'frontera');
      assert.equal(body['version'], pkg.version);
      assert.deepEqual(Object.keys(body).sort(), ['api', 'build', 'canonicalizationVersion', 'commit', 'node', 'package', 'product', 'release', 'runtimeVersions', 'schema', 'storeSchemaVersions', 'version']);
      assert.equal(text.includes('PROD0303VERSIONCANARYKEY'), false, 'no credential');
      assert.equal(text.includes(process.cwd()), false, 'no filesystem path');
      // No environment variable reaches it: the identity is read from the artifact, not the configuration.
      assert.equal(/AOC_ENTERPRISE|configurationChecksum|posture/.test(text), false);
    } finally {
      await server.close();
    }
  });
});
