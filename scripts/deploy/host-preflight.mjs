// PROD-03-03 — the Enterprise Host deployment preflight.
//
// One function, two callers:
//   - `npm run check:host-configuration` (scripts/check-host-configuration.mjs):
//     an operator validates a deployment without starting it;
//   - the launcher (scripts/run-enterprise-host.mjs) runs the same checks
//     before `bootEnterpriseHost()`, so a container never starts on a
//     configuration the check would have refused.
//
// It adds no configuration rule of its own to the Host's: the configuration
// verdict IS `loadEnterpriseHostConfiguration()` — the Host's strict parser and
// secure-profile rules, with the Host's own refusal codes. Around it, it checks
// what a parser cannot see: the build's release identity, placeholder secrets,
// and the storage the configuration points at — every store this deployment
// composes (the PROD-02 store registry decides which), whether its directory is
// writable, whether an existing file is a readable SQLite database at a schema
// version this build opens, and, inside a
// container, whether the stores would live on the container's writable layer.
//
// Nothing here starts a listener, opens a store for writing or contacts the
// signer or the witness. Output names variables, stores and closed codes —
// never a value, a path or a secret.

import { randomBytes } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStoreVersion, sqliteIntegrityCheck } from '../portability/lib-portability.mjs';
import { deriveDeploymentRequirements, loadRegistryModules, requiredStoreDefinitions } from '../portability/store-registry.mjs';

export const PREFLIGHT_FORMAT = 'frontera.host-preflight.v1';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * A value that is still the shipped example's placeholder, never a secret
 * anyone chose: `<required-secret>`, `<required: …>`, `REPLACE_ME`, `CHANGE_ME`.
 */
const PLACEHOLDER = /<required[^>]*>|\bREPLACE[_-]?ME\b|\bCHANGE[_-]?ME\b/i;

function pass(id, detail) {
  return { id, status: 'pass', detail };
}
function fail(id, code, detail) {
  return { id, status: 'fail', code, detail };
}
function warn(id, detail) {
  return { id, status: 'warn', detail };
}
function skip(id, detail) {
  return { id, status: 'skip', detail };
}

/** One line, never a stack. Messages from the Host's own errors are secret-free by construction. */
function messageOf(error) {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0];
}

function inContainer() {
  return existsSync('/.dockerenv') || existsSync('/run/.containerenv');
}

/**
 * Where a store file will really be, walking every path component and
 * following every symlink, the way the kernel will when the store opens it.
 * Components that do not exist yet are kept as written (the store creates its
 * directories). `{ refused }` when the walk cannot succeed for the Host
 * either: a symlink loop, or a symlinked directory whose target is missing
 * (the store's recursive mkdir fails there). Only the file itself may be a
 * link to a target that does not exist yet — SQLite creates the target.
 */
function storeLocation(path) {
  const pending = resolve(path).split(sep).filter(Boolean);
  let current = sep;
  let hops = 0;
  while (pending.length > 0) {
    const next = join(current, pending.shift());
    let stats;
    try {
      stats = lstatSync(next);
    } catch {
      return { location: join(next, ...pending) };
    }
    if (!stats.isSymbolicLink()) {
      current = next;
      continue;
    }
    hops += 1;
    if (hops > 40) return { refused: 'its path contains a symlink loop' };
    const target = resolve(current, readlinkSync(next));
    if (pending.length > 0 && !existsSync(target)) return { refused: 'a directory in its path is a symlink to a missing target' };
    // The file itself may be a link to a database not created yet, but only
    // into an existing directory: a store creates its configured directory,
    // never the directories of a link's target.
    if (pending.length === 0 && !existsSync(target) && !existsSync(dirname(target))) return { refused: 'it is a symlink into a directory that does not exist' };
    pending.unshift(...target.split(sep).filter(Boolean));
    current = sep;
  }
  return { location: current };
}

/** The nearest existing ancestor of `path` (the directory itself when it exists). */
function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/** A real write probe: `access()` answers "yes" for root whatever the mount says. */
function directoryWritable(dir) {
  // Unique per call: one-off containers all run as PID 1 on a shared volume.
  const probe = join(dir, `.frontera-preflight-${process.pid}-${randomBytes(8).toString('hex')}`);
  try {
    accessSync(dir, constants.W_OK | constants.X_OK);
    closeSync(openSync(probe, 'wx', 0o600));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

/** Filesystems that live and die with the container (or the machine's RAM). */
const EPHEMERAL_FILESYSTEMS = new Set(['tmpfs', 'ramfs']);

/**
 * The filesystem type of the mount that holds `dir` (Linux, from
 * /proc/self/mountinfo: the longest mount point containing it), or undefined
 * where that cannot be read.
 */
function filesystemOf(dir) {
  let mountinfo;
  try {
    mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return undefined;
  }
  const unescape = (field) => field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
  let best;
  for (const line of mountinfo.split('\n')) {
    const [left, right] = line.split(' - ');
    if (right === undefined) continue;
    const mountPoint = unescape(left.split(' ')[4] ?? '');
    const contains = mountPoint === '/' || dir === mountPoint || dir.startsWith(`${mountPoint}/`);
    if (contains && (best === undefined || mountPoint.length >= best.mountPoint.length)) best = { mountPoint, type: right.split(' ')[0] };
  }
  return best?.type;
}

async function checkStore(storeDef, path, modules, secure, rootDevice) {
  const problems = [];
  const warnings = [];
  const label = `${storeDef.name} (${storeDef.envVar})`;
  if (!isAbsolute(path)) warnings.push(`${label} is a relative path, resolved against the working directory`);
  // Every check below is about where the bytes will actually live: the path
  // with every symlink resolved — the file's own and its directories' — so a
  // link from the mounted volume to the container layer cannot pass.
  const resolved = storeLocation(path);
  if (resolved.refused !== undefined) {
    problems.push(['STORAGE_UNAVAILABLE', `${label}: ${resolved.refused}`]);
    return { problems, warnings };
  }
  const absolute = resolved.location;
  // A missing directory chain is fine: every store creates its own parent
  // directories (recursive mkdir) when it opens. What must hold is that the
  // nearest existing ancestor is writable and, in a container, on a volume.
  const dir = dirname(absolute);
  const existingDir = nearestExisting(dir);

  if (!statSync(existingDir).isDirectory()) {
    problems.push(['STORAGE_UNAVAILABLE', `${label}: a parent of its directory is not a directory`]);
    return { problems, warnings };
  }
  if (!directoryWritable(existingDir)) {
    problems.push(['STORAGE_NOT_WRITABLE', `${label}: its directory is not writable by this process`]);
    return { problems, warnings };
  }
  // Inside a container, a store on the same device as `/` is on the
  // container's writable layer: it disappears with the container.
  if (secure && rootDevice !== undefined && statSync(existingDir).dev === rootDevice) {
    problems.push(['STORAGE_NOT_PERSISTENT', `${label}: its directory is on the container's writable layer, not on a mounted volume`]);
  } else if (secure && EPHEMERAL_FILESYSTEMS.has(filesystemOf(existingDir) ?? '')) {
    // A mount, but one that does not outlive the container (e.g. a Docker tmpfs mount).
    problems.push(['STORAGE_NOT_PERSISTENT', `${label}: its directory is on an in-memory filesystem (${filesystemOf(existingDir)})`]);
  }

  if (!existsSync(absolute)) return { problems, warnings, state: 'absent' };
  if (!statSync(absolute).isFile()) {
    problems.push(['STORAGE_UNAVAILABLE', `${label}: exists but is not a regular file`]);
    return { problems, warnings };
  }
  for (const file of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
    if (!existsSync(file)) continue;
    try {
      accessSync(file, constants.R_OK | constants.W_OK);
    } catch {
      problems.push(['STORAGE_NOT_WRITABLE', `${label}: an existing database file is not readable and writable by this process`]);
      return { problems, warnings };
    }
  }
  if (statSync(absolute).size === 0) return { problems, warnings, state: 'empty' };

  const integrity = await sqliteIntegrityCheck(absolute);
  if (!integrity.ok) {
    problems.push(['STORAGE_UNAVAILABLE', `${label}: not a readable, intact SQLite database`]);
    return { problems, warnings };
  }
  let version;
  try {
    version = await readStoreVersion(absolute, storeDef.version);
  } catch {
    problems.push(['SCHEMA_INCOMPATIBLE', `${label}: its schema version cannot be read`]);
    return { problems, warnings };
  }
  const supported = storeDef.supportedSchemaVersionsOf(modules);
  if (version.schemaVersion === null) {
    problems.push(['SCHEMA_INCOMPATIBLE', `${label}: the database records no ${storeDef.name} schema version (expected ${supported.join(' or ')})`]);
  } else if (!supported.includes(version.schemaVersion)) {
    problems.push(['SCHEMA_INCOMPATIBLE', `${label}: schema '${version.schemaVersion}' is not one this build opens (${supported.join(' or ')}); see the rollback boundary in docs/deployment/PILOT_DEPLOYMENT.md`]);
  }
  // No rule on `migration_state`: it is each store's own label ('fresh',
  // 'current', 'migrated', …), and every migration runs inside one SQLite
  // transaction when the store opens, so an unfinished one is never persisted.
  // Each store judges its own row when the Host opens it.
  return { problems, warnings, state: 'existing' };
}

/**
 * Runs every check. Returns `{ ok, checks, configuration }`; `configuration`
 * is the Host's resolved configuration when it parsed (callers never print it).
 */
export async function runHostPreflight(env, { root = ROOT } = {}) {
  const checks = [];

  // 1. Release identity — the same reader `GET /version` uses.
  const { readReleaseIdentity } = await import(resolve(root, 'dist/src/enterprise/host/release-identity.js'));
  try {
    const identity = readReleaseIdentity(root);
    checks.push(pass('release-identity', `${identity.release} (build=${identity.build})`));
  } catch (error) {
    checks.push(fail('release-identity', 'RELEASE_IDENTITY_INVALID', messageOf(error)));
  }

  // 2. Placeholders — before anything resolves a secret. Names only. Only what
  // the Host reads: its own variables (AOC_ENTERPRISE_*, FRONTERA_*) and every
  // secret the governed-action file names; an unrelated variable is not ours.
  let referenced = [];
  try {
    referenced = deriveDeploymentRequirements(env, { persistence: { provider: 'memory' } }).secretReferenceEnvVars;
  } catch {
    // An unreadable file is reported by the configuration check below.
  }
  const hostReads = (name) => /^(AOC_ENTERPRISE|FRONTERA)_/.test(name) || referenced.includes(name);
  const placeholders = Object.entries(env)
    .filter(([name, value]) => hostReads(name) && typeof value === 'string' && PLACEHOLDER.test(value))
    .map(([name]) => name)
    .sort();
  checks.push(
    placeholders.length === 0
      ? pass('placeholders', 'no variable still holds an example placeholder')
      : fail('placeholders', 'CONFIG_PLACEHOLDER_VALUE', `still the example placeholder, replace before startup: ${placeholders.join(', ')}`),
  );

  // 3. Configuration — the Host's own parser and secure-profile rules, verbatim.
  const enterprise = await import(resolve(root, 'dist/src/enterprise/index.js'));
  let host;
  try {
    host = enterprise.loadEnterpriseHostConfiguration(env);
    const configuration = host.configuration;
    checks.push(
      pass(
        'configuration',
        `environment=${configuration.environment} secure-profile=${host.secureProfile ? 'yes' : 'no'} persistence=${configuration.persistence.provider} authentication=${configuration.features.requireAuthentication ? 'required' : 'disabled'} governed-actions=${host.governedActions !== undefined ? 'configured' : 'not-configured'} listen=${configuration.http.host}:${configuration.http.port}`,
      ),
    );
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'CONFIG_INVALID';
    // The Host's messages name variables, not values — except the governed-action
    // file's own path when it cannot be read. The report stays path-free.
    const file = env.AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE;
    const detail = typeof file === 'string' && file.length > 0 ? messageOf(error).split(file).join('<AOC_ENTERPRISE_GOVERNED_ACTIONS_FILE>') : messageOf(error);
    checks.push(fail('configuration', code, detail));
  }

  // 4. Storage — every store this deployment composes.
  if (host === undefined) {
    checks.push(skip('storage', 'configuration did not parse'));
  } else if (host.configuration.persistence.provider !== 'sqlite') {
    checks.push(
      host.secureProfile
        ? fail('storage', 'STORAGE_NOT_DURABLE', 'persistence is not sqlite')
        : warn('storage', 'persistence is in memory: nothing survives a restart (development only)'),
    );
  } else {
    let required;
    try {
      required = requiredStoreDefinitions(deriveDeploymentRequirements(env, host.configuration));
    } catch (error) {
      checks.push(fail('storage', 'CONFIG_INVALID', messageOf(error)));
    }
    if (required !== undefined) {
      const modules = await loadRegistryModules(root);
      const rootDevice = inContainer() ? statSync('/').dev : undefined;
      const paths = new Map();
      const problems = [];
      const warnings = [];
      const states = { absent: 0, empty: 0, existing: 0 };
      for (const storeDef of required) {
        const path = storeDef.configPathOf(host.configuration);
        if (typeof path !== 'string' || path.length === 0) {
          problems.push(['STORAGE_UNAVAILABLE', `${storeDef.name} (${storeDef.envVar}): no path configured`]);
          continue;
        }
        // Where the file actually is: symlinks in the path resolved, and an
        // existing file identified by device and inode, so no alias (symlink,
        // hard link, another spelling) can put two stores in one database.
        const keys = [`path:${storeLocation(path).location ?? resolve(path)}`];
        if (existsSync(path)) {
          const { dev, ino } = statSync(path);
          keys.push(`inode:${dev}:${ino}`);
        }
        const collision = keys.find((key) => paths.has(key));
        if (collision !== undefined) problems.push(['STORAGE_PATHS_COLLIDE', `${storeDef.envVar} and ${paths.get(collision)} name the same file`]);
        for (const key of keys) paths.set(key, storeDef.envVar);
        // SQLite's companions belong to their database: no store may be configured onto them.
        for (const suffix of ['-wal', '-shm', '-journal']) paths.set(`${keys[0]}${suffix}`, `${storeDef.envVar} (${suffix.slice(1)})`);
        const result = await checkStore(storeDef, path, modules, host.secureProfile, rootDevice);
        // Every composed store, optional modules' included: the Host opens them
        // all at composition and refuses to start when one cannot be opened.
        // (Optional-module criticality governs outages after startup.)
        problems.push(...result.problems);
        warnings.push(...result.warnings);
        if (result.state !== undefined) states[result.state] += 1;
      }
      for (const [code, detail] of problems) checks.push(fail('storage', code, detail));
      for (const detail of warnings) checks.push(warn('storage', detail));
      if (problems.length === 0) {
        checks.push(pass('storage', `${required.length} composed stores writable: ${states.existing} existing at a supported schema, ${states.absent + states.empty} to be created on first start`));
      }
    }
  }

  return { ok: checks.every((check) => check.status !== 'fail'), checks, configuration: host };
}

/** Deterministic, value-free report lines. */
export function formatPreflight(result) {
  const lines = [`Frontera Host preflight (${PREFLIGHT_FORMAT})`];
  for (const check of result.checks) {
    const status = check.status.toUpperCase().padEnd(4);
    lines.push(`${status} ${check.id.padEnd(16)} ${check.code !== undefined ? `[${check.code}] ` : ''}${check.detail}`);
  }
  const failures = result.checks.filter((check) => check.status === 'fail').length;
  lines.push(failures === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failures} problem${failures === 1 ? '' : 's'})`);
  return lines;
}

/** The first failure, for a one-line refusal. */
export function firstFailure(result) {
  return result.checks.find((check) => check.status === 'fail');
}
