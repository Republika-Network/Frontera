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
// The API surface and runtime versions come from the same construction as
// release/RELEASE_MANIFEST.json (scripts/lib-release-manifest.mjs), so the
// identity a deployed Host reports and the committed manifest cannot disagree;
// the store schema versions come from the PROD-02 store registry, for every
// store the Host can compose.
// The result is re-read through the Host's own validator before this exits 0.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReleaseManifest } from '../lib-release-manifest.mjs';
import { STORE_DEFINITIONS, loadRegistryModules } from '../portability/store-registry.mjs';

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
// Every store the Host can compose, from the same registry the preflight,
// backup and restore use — not the manifest's historical subset.
const modules = await loadRegistryModules(root);
const storeSchemaVersions = Object.fromEntries(STORE_DEFINITIONS.map((storeDef) => [storeDef.name, [...storeDef.supportedSchemaVersionsOf(modules)]]));
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
  storeSchemaVersions,
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
