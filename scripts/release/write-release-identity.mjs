// PROD-03-03 — records the release identity of a built artifact.
//
// Run AFTER `npm run build`. Writes dist/release-identity.json, which the
// running Host serves at `GET /version` (src/enterprise/host/release-identity.ts).
//
//   FRONTERA_BUILD_COMMIT=<40-hex commit> node scripts/release/write-release-identity.mjs
//
// The commit is an input, never discovered: the container build has no `.git`
// (see .dockerignore), and the person or CI job that builds the artifact is the
// one who knows which commit the build context came from. Without a commit the
// artifact is recorded as a `development` build — `commit: "unknown"`,
// `release: "<version>+development"` — never as a release.
//
// Every other field comes from the same construction as
// release/RELEASE_MANIFEST.json (scripts/lib-release-manifest.mjs), so the
// identity a deployed Host reports and the committed manifest cannot disagree
// about the API surface, the runtime versions or the store schema versions.
// The result is re-read through the Host's own validator before this exits 0.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseManifest } from '../lib-release-manifest.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const COMMIT = /^[0-9a-f]{40}$/;

function refuse(message) {
  console.error(`[release-identity] ${message}`);
  process.exit(1);
}

const commitInput = (process.env.FRONTERA_BUILD_COMMIT ?? '').trim();
if (commitInput !== '' && !COMMIT.test(commitInput)) {
  refuse('FRONTERA_BUILD_COMMIT must be a full 40-character lowercase hex commit (git rev-parse HEAD), or unset for a development build.');
}

const manifest = await buildReleaseManifest();
const build = commitInput === '' ? 'development' : 'release';
const identity = {
  schema: 'frontera.release-identity.v1',
  product: 'frontera',
  package: manifest.name,
  version: manifest.version,
  commit: build === 'release' ? commitInput : 'unknown',
  release: build === 'release' ? `${manifest.version}+${commitInput.slice(0, 12)}` : `${manifest.version}+development`,
  build,
  api: { surface: manifest.api.surface, endpointCount: manifest.api.endpointCount },
  runtimeVersions: { enterpriseHost: manifest.runtimeVersions.enterpriseHost, kernel: manifest.runtimeVersions.kernel },
  storeSchemaVersions: manifest.storeSchemaVersions,
  canonicalizationVersion: manifest.canonicalizationVersion,
  node: { supported: manifest.compatibilityMatrix.node },
};

const out = resolve(root, 'dist/release-identity.json');
writeFileSync(out, `${JSON.stringify(identity, null, 2)}\n`, 'utf8');

// What the Host will read back, through the Host's own validator.
const { readReleaseIdentity } = await import(resolve(root, 'dist/src/enterprise/host/release-identity.js'));
let served;
try {
  served = readReleaseIdentity(root);
} catch (error) {
  refuse(`the recorded identity does not validate: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`release identity: ${served.release} (build=${served.build}, api=${served.api.surface}/${served.api.endpointCount})`);
