import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AOC_KERNEL_VERSION } from '../../kernel/index.js';
import { AOC_ENTERPRISE_HOST_VERSION } from '../version.js';

/**
 * PROD-03-03 — "What exact Frontera build is running?"
 *
 * The answer is fixed when the runtime artifact is built, never when it is
 * configured: `scripts/release/write-release-identity.mjs` writes
 * `dist/release-identity.json` (the container image does this in its build
 * stage, from the commit it was built from), and the running Host reads it
 * back. No environment variable can set or override it, and nothing here
 * needs `.git` at runtime.
 *
 * A build that never recorded an identity (a plain `npm run build` in a
 * working tree) says so — `build: 'development'`, `commit: 'unknown'` — rather
 * than inventing one. A recorded identity that does not match the code it
 * ships with (another package version, another Host or Kernel version) is
 * refused: `ReleaseIdentityError`, which the preflight turns into a startup
 * refusal.
 *
 * Every field is public build metadata: no path, user, machine name, secret
 * or configuration value. `GET /version` serves exactly this object.
 */

export const RELEASE_IDENTITY_FILENAME = 'release-identity.json';
export const RELEASE_IDENTITY_SCHEMA = 'frontera.release-identity.v1';

export interface FronteraReleaseIdentity {
  readonly schema: typeof RELEASE_IDENTITY_SCHEMA;
  readonly product: 'frontera';
  /** The npm package the artifact was built from. */
  readonly package: string;
  readonly version: string;
  /** The full 40-hex commit the artifact was built from, or `unknown`. */
  readonly commit: string;
  /** `<version>+<12-hex commit>` for an identified build, else `<version>+development`. */
  readonly release: string;
  /** `release`: built from a recorded commit. `development`: no recorded identity. */
  readonly build: 'release' | 'development';
  readonly api: { readonly surface: string; readonly endpointCount: number | null };
  readonly runtimeVersions: { readonly enterpriseHost: string; readonly kernel: string };
  /** The store schema versions this build opens; a store written under any other is refused at startup. */
  readonly storeSchemaVersions: Readonly<Record<string, string>> | null;
  readonly canonicalizationVersion: string | null;
  readonly node: { readonly supported: string | null; readonly running: string };
}

export class ReleaseIdentityError extends Error {
  readonly code = 'RELEASE_IDENTITY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseIdentityError';
  }
}

const COMMIT = /^[0-9a-f]{40}$/;
const API_SURFACE = 'aoc-enterprise-host-http.v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new ReleaseIdentityError(`${RELEASE_IDENTITY_FILENAME}: ${message}`);
}

function token(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9@/._+:>=<-]{1,128}$/.test(value)) invalid(`'${field}' must be a short token.`);
  return value;
}

/** The artifact root: `dist/src/enterprise/host/` → four levels up. */
function artifactRoot(): string {
  return join(__dirname, '..', '..', '..', '..');
}

function packageMetadata(root: string): { readonly name: string; readonly version: string } {
  const parsed: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!isRecord(parsed) || typeof parsed['name'] !== 'string' || typeof parsed['version'] !== 'string') {
    throw new ReleaseIdentityError('package.json has no name or version.');
  }
  return { name: parsed['name'], version: parsed['version'] };
}

/**
 * Validates a recorded identity against the code it ships with. Exported for
 * the preflight and the tests; the Host reads it through `readReleaseIdentity`.
 */
export function parseReleaseIdentity(value: unknown, pkg: { readonly name: string; readonly version: string }): FronteraReleaseIdentity {
  if (!isRecord(value)) invalid('must be a JSON object.');
  if (value['schema'] !== RELEASE_IDENTITY_SCHEMA) invalid(`'schema' must be '${RELEASE_IDENTITY_SCHEMA}'.`);
  if (value['product'] !== 'frontera') invalid(`'product' must be 'frontera'.`);
  if (value['package'] !== pkg.name) invalid(`'package' does not match the shipped package.json.`);
  if (value['version'] !== pkg.version) invalid(`'version' does not match the shipped package.json version (${pkg.version}).`);
  const commit = value['commit'];
  if (typeof commit !== 'string' || !(COMMIT.test(commit) || commit === 'unknown')) invalid(`'commit' must be a full 40-hex commit or 'unknown'.`);
  const build = value['build'];
  if (build !== 'release' && build !== 'development') invalid(`'build' must be 'release' or 'development'.`);
  if (build === 'release' && commit === 'unknown') invalid(`a 'release' build must record its commit.`);
  const expectedRelease = build === 'release' ? `${pkg.version}+${commit.slice(0, 12)}` : `${pkg.version}+development`;
  if (value['release'] !== expectedRelease) invalid(`'release' must be '${expectedRelease}'.`);

  const api = value['api'];
  if (!isRecord(api) || api['surface'] !== API_SURFACE || !Number.isInteger(api['endpointCount']) || (api['endpointCount'] as number) <= 0) {
    invalid(`'api' must name surface '${API_SURFACE}' and a positive endpointCount.`);
  }
  const runtime = value['runtimeVersions'];
  if (!isRecord(runtime) || runtime['enterpriseHost'] !== AOC_ENTERPRISE_HOST_VERSION || runtime['kernel'] !== AOC_KERNEL_VERSION) {
    invalid(`'runtimeVersions' does not match the shipped Enterprise Host (${AOC_ENTERPRISE_HOST_VERSION}) and Kernel (${AOC_KERNEL_VERSION}).`);
  }
  const schemas = value['storeSchemaVersions'];
  if (!isRecord(schemas)) invalid(`'storeSchemaVersions' must be an object.`);
  const storeSchemaVersions = Object.fromEntries(Object.entries(schemas).map(([store, version]) => [token(store, 'storeSchemaVersions'), token(version, `storeSchemaVersions.${store}`)]));
  const node = value['node'];
  if (!isRecord(node)) invalid(`'node' must be an object.`);

  return {
    schema: RELEASE_IDENTITY_SCHEMA,
    product: 'frontera',
    package: pkg.name,
    version: pkg.version,
    commit,
    release: expectedRelease,
    build,
    api: { surface: API_SURFACE, endpointCount: api['endpointCount'] as number },
    runtimeVersions: { enterpriseHost: AOC_ENTERPRISE_HOST_VERSION, kernel: AOC_KERNEL_VERSION },
    storeSchemaVersions,
    canonicalizationVersion: token(value['canonicalizationVersion'], 'canonicalizationVersion'),
    node: { supported: token(node['supported'], 'node.supported'), running: process.version },
  };
}

/** The identity of a build that recorded none. Says what it does not know. */
export function developmentReleaseIdentity(pkg: { readonly name: string; readonly version: string }): FronteraReleaseIdentity {
  return {
    schema: RELEASE_IDENTITY_SCHEMA,
    product: 'frontera',
    package: pkg.name,
    version: pkg.version,
    commit: 'unknown',
    release: `${pkg.version}+development`,
    build: 'development',
    api: { surface: API_SURFACE, endpointCount: null },
    runtimeVersions: { enterpriseHost: AOC_ENTERPRISE_HOST_VERSION, kernel: AOC_KERNEL_VERSION },
    storeSchemaVersions: null,
    canonicalizationVersion: null,
    node: { supported: null, running: process.version },
  };
}

/**
 * Reads the identity recorded in `<root>/dist/release-identity.json`, or the
 * development identity when none was recorded. Throws `ReleaseIdentityError`
 * on a recorded identity that is malformed or does not match this build.
 */
export function readReleaseIdentity(root: string = artifactRoot()): FronteraReleaseIdentity {
  const pkg = packageMetadata(root);
  const file = join(root, 'dist', RELEASE_IDENTITY_FILENAME);
  if (!existsSync(file)) return developmentReleaseIdentity(pkg);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    invalid('is not valid JSON.');
  }
  return parseReleaseIdentity(parsed, pkg);
}

let cached: FronteraReleaseIdentity | undefined;

/** The running artifact's identity, read once. */
export function currentReleaseIdentity(): FronteraReleaseIdentity {
  cached ??= readReleaseIdentity();
  return cached;
}
