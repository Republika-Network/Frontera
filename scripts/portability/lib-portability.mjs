// Shared helpers for the AOC Enterprise v1 backup/restore/portability tooling
// (docs/release/AOC_ENTERPRISE_V1_PORTABILITY_REPORT.md). Used by
// backup-enterprise-v1.mjs, restore-enterprise-v1.mjs,
// generate-portability-fixture.mjs, compare-portability-state.mjs, and
// validate-portability-v1.mjs so all five agree on the backup format,
// store list, and canonicalization.
//
// Reuses the runtime's own exported canonical JSON serializer
// (`canonicalSerialize`, `aoc.canonical-json.v1`) rather than inventing a
// second canonicalization -- see AOC_ENTERPRISE_V1_PORTABILITY_CURRENT_STATE.md.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync, lstatSync, mkdirSync, readdirSync, rmSync, renameSync, mkdtempSync, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

export const BACKUP_FORMAT = 'aoc.enterprise.backup.v1';

export const REPO_ROOT = resolve(new URL('../..', import.meta.url).pathname);

// PROD-02: the store list lives in ONE place, `store-registry.mjs`, and is
// re-exported here so every existing importer keeps working. Nothing in this
// directory maintains a second list.
export { STORE_DEFINITIONS } from './store-registry.mjs';
import { STATIC_SECRET_ENV_VARS } from './store-registry.mjs';

/** Secrets that must never be copied into a backup (Phase 7; PROD-02 extends the inventory). Names only — never values. */
export const EXCLUDED_SECRET_ENV_VARS = STATIC_SECRET_ENV_VARS;

let cachedEnterpriseModule;
let cachedBetterSqlite3;

/** Dynamically imports the built package's `./enterprise` subpath -- the same public surface `scripts/lib-release-manifest.mjs` already imports from `dist/src/enterprise/index.js`. Requires `npm run build` to have run first. */
export async function loadEnterpriseModule() {
  if (cachedEnterpriseModule === undefined) {
    const distPath = resolve(REPO_ROOT, 'dist/src/enterprise/index.js');
    if (!existsSync(distPath)) {
      throw new Error(`Built output not found at ${distPath}. Run "npm run build" before using the portability tooling.`);
    }
    cachedEnterpriseModule = await import(distPath);
  }
  return cachedEnterpriseModule;
}

/** Lazily loads `better-sqlite3` -- the project's own SQLite dependency (never the `sqlite3` CLI, per Phase 5/6). */
export async function loadBetterSqlite3() {
  if (cachedBetterSqlite3 === undefined) {
    const mod = await import('better-sqlite3');
    cachedBetterSqlite3 = mod.default ?? mod;
  }
  return cachedBetterSqlite3;
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

export function sha256File(path) {
  return sha256Buffer(readFileSync(path));
}

/** Recursively sorts object keys (mirrors `aoc.canonical-json.v1`'s ordering rule) so a manifest is stable and diff-friendly on disk, while staying human-readable (pretty-printed) -- unlike `canonicalSerialize`, which is compact and meant for digesting, not for storage. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

export function stableJsonStringify(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

/**
 * The real location of `path`: symlinks in its nearest existing ancestor are
 * resolved, the not-yet-existing remainder appended. Overlap is judged on where
 * files actually live, never on how a path is spelled.
 */
export function realResolve(path) {
  let current = resolve(path);
  const rest = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    rest.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return rest.length === 0 ? base : join(base, ...rest);
}

/** Resolves an absolute path and asserts it does not sit inside `ancestorPath` (or vice versa) -- guards against a backup destination recursing into a source store directory, or a restore target escaping via `..` (Phase 7/8 path-traversal requirements). */
export function assertNoPathOverlap(pathA, pathB, description) {
  const a = realResolve(pathA);
  const b = realResolve(pathB);
  if (a === b) throw new Error(`${description}: paths must not be identical (${a}).`);
  const aWithSep = `${a}${sep}`;
  const bWithSep = `${b}${sep}`;
  if (a.startsWith(bWithSep) || b.startsWith(aWithSep)) {
    throw new Error(`${description}: '${a}' and '${b}' must not be nested inside one another.`);
  }
}

/** Asserts `candidatePath`, once resolved, still lives inside `containerPath` -- rejects `../../etc/passwd`-style manifest filenames before they are ever opened. */
export function assertContained(containerPath, candidatePath, description) {
  const container = resolve(containerPath);
  const candidate = resolve(containerPath, candidatePath);
  if (candidate !== container && !candidate.startsWith(`${container}${sep}`)) {
    throw new Error(`${description}: '${candidatePath}' escapes its containing directory.`);
  }
  return candidate;
}

/** Refuses a symlink at `path` -- a backup/restore file set must be real files, never a link an attacker could repoint after validation (Phase 7/8/27). */
export function assertNotSymlink(path, description) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`${description}: '${path}' is a symlink, which is not permitted in a backup or restore file set.`);
  }
}

export async function sqliteIntegrityCheck(dbPath) {
  const Database = await loadBetterSqlite3();
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check');
    const ok = rows.length === 1 && rows[0].integrity_check === 'ok';
    return { ok, detail: ok ? 'ok' : rows.map((row) => row.integrity_check).join('; ') };
  } catch (error) {
    // A file so damaged that the check itself cannot run is an integrity failure, not a crash.
    return { ok: false, detail: error.message };
  } finally {
    db?.close();
  }
}

/**
 * The schema version a store file records, read the way its own store reads
 * it: a `versions` table (newest row; with or without `migration_state`) or a
 * single-row `meta` table (integer version). `{ schemaVersion: null }` when the
 * file carries no version record at all.
 */
export async function readStoreVersion(dbPath, version) {
  const descriptor = typeof version === 'string' ? { kind: 'versions-table', table: version, migrationState: true } : version;
  const Database = await loadBetterSqlite3();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(descriptor.table);
    if (tableExists === undefined) return { schemaVersion: null, migrationState: null };
    if (descriptor.kind === 'meta-row') {
      const row = db.prepare(`SELECT schema_version FROM ${descriptor.table} WHERE id = 1`).get();
      return { schemaVersion: row?.schema_version ?? null, migrationState: null };
    }
    const columns = descriptor.migrationState ? 'schema_version, migration_state' : 'schema_version';
    const row = db.prepare(`SELECT ${columns} FROM ${descriptor.table} ORDER BY id DESC LIMIT 1`).get();
    return { schemaVersion: row?.schema_version ?? null, migrationState: row?.migration_state ?? null };
  } finally {
    db.close();
  }
}

export async function recordCount(dbPath, table) {
  const Database = await loadBetterSqlite3();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
    if (tableExists === undefined) return 0;
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return row.count;
  } finally {
    db.close();
  }
}

/** Row counts of every user table in the file — logical evidence beside the byte checksum. */
export async function tableCounts(dbPath) {
  const Database = await loadBetterSqlite3();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map((row) => row.name);
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS count FROM "${table.replace(/"/g, '""')}"`).get().count]));
  } finally {
    db.close();
  }
}

/**
 * The identity and head of a signed (CORE-01/04/05) store, read from the file
 * itself: store id, organization, head sequence and digest, the signing key id
 * and the count of rows the head commits to. Never a signature value used for
 * anything but its key id. `null` for a store without a signed head.
 *
 * Also the structural consistency check a restore can always run, with or
 * without trusted verification keys: a head without rows, rows without a head,
 * or a head whose sequence does not equal the rows it commits to is refused.
 */
export async function readSignedHead(dbPath, signedHead) {
  if (signedHead === undefined) return null;
  const Database = await loadBetterSqlite3();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const has = (table) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
    for (const table of [signedHead.table, signedHead.rowTable, ...(signedHead.metaTable !== undefined ? [signedHead.metaTable] : [])]) {
      if (!has(table)) return { consistent: false, problem: `missing table '${table}'` };
    }
    if (signedHead.metaTable !== undefined) {
      const meta = db.prepare(`SELECT store_id, organization_id FROM ${signedHead.metaTable} WHERE id = 1`).get();
      const head = db.prepare(`SELECT sequence, chain_digest, signature_json FROM ${signedHead.table} WHERE id = 1`).get();
      const rows = db.prepare(`SELECT COUNT(*) AS count, MAX(sequence) AS max FROM ${signedHead.rowTable}`).get();
      if (meta === undefined) return { consistent: false, problem: 'no store identity' };
      if (head === undefined) return { consistent: false, problem: 'rows without a signed head' };
      let keyId = null;
      try {
        keyId = JSON.parse(head.signature_json)?.keyId ?? null;
      } catch {
        keyId = null;
      }
      const consistent = rows.count === head.sequence && (rows.max ?? 0) === head.sequence;
      return {
        consistent,
        ...(consistent ? {} : { problem: `head sequence ${head.sequence} does not commit to the ${rows.count} rows present` }),
        storeId: meta.store_id,
        organizationId: meta.organization_id,
        sequence: head.sequence,
        stateDigest: head.chain_digest,
        signingKeyId: keyId,
        rowCount: rows.count,
      };
    }
    const head = db.prepare(`SELECT store_id, sequence, revocation_set_digest, signing_key_id FROM ${signedHead.table}`).all();
    const revocations = db.prepare(`SELECT COUNT(*) AS count FROM ${signedHead.rowTable}`).get();
    if (head.length !== 1) return { consistent: false, problem: head.length === 0 ? 'no signed revocation-state commitment' : 'more than one revocation-state commitment' };
    const [state] = head;
    const consistent = revocations.count === state.sequence;
    return {
      consistent,
      ...(consistent ? {} : { problem: `revocation-state sequence ${state.sequence} does not commit to the ${revocations.count} revocations present` }),
      storeId: state.store_id,
      organizationId: null,
      sequence: state.sequence,
      stateDigest: state.revocation_set_digest,
      signingKeyId: state.signing_key_id,
      rowCount: revocations.count,
    };
  } finally {
    db.close();
  }
}

/** The SQLite sidecars of a database path that exist on disk (`-wal`, `-shm`, `-journal`). */
export function sqliteSidecars(dbPath) {
  return ['-wal', '-shm', '-journal'].map((suffix) => `${dbPath}${suffix}`).filter((path) => existsSync(path));
}

/**
 * Makes a transactionally-consistent copy of a possibly-live (WAL-mode)
 * SQLite database using SQLite's own Online Backup API, exposed by
 * better-sqlite3 as `Database#backup()` (Phase 6). Never a plain
 * byte-level `cp` of a live database.
 *
 * The copy inherits the source's `journal_mode`. If that is `wal` (the
 * runtime's default -- see `sqlite-governance-store.ts` and siblings), the
 * copy is switched to `journal_mode = DELETE` immediately afterward: a
 * backup artifact must be one self-contained file, exactly like the
 * existing manual procedure's `sqlite3 <db> ".backup ..."` output
 * (`docs/operations/BACKUP_RECOVERY_V1.md`: "no sidecars needed on
 * restore"). Without this, even a later *read-only* open of the WAL copy
 * would create `-shm`/`-wal` sidecars next to it.
 */
export async function safeSqliteCopy(sourcePath, destPath) {
  const Database = await loadBetterSqlite3();
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }

  const copy = new Database(destPath, { fileMustExist: true });
  try {
    const [{ journal_mode: mode }] = copy.pragma('journal_mode');
    if (mode === 'wal') copy.pragma('journal_mode = DELETE');
  } finally {
    copy.close();
  }
}

export function gitInfo() {
  const git = (args) => {
    try {
      return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: git('rev-parse HEAD'),
    branch: git('rev-parse --abbrev-ref HEAD'),
  };
}

/** A staging directory created as a *sibling* of `finalPath` so the final move is a same-filesystem `rename` (atomic) rather than a cross-device copy (Phase 5 point 16). */
export function createStagingDir(finalPath, prefix) {
  const parent = dirname(resolve(finalPath));
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `.${prefix}-staging-`));
}

export function atomicPromote(stagingDir, finalPath, { force = false } = {}) {
  const resolvedFinal = resolve(finalPath);
  if (existsSync(resolvedFinal)) {
    const entries = readdirSync(resolvedFinal);
    if (entries.length > 0 && !force) {
      throw new Error(`Destination '${resolvedFinal}' already exists and is non-empty. Pass --force to replace it.`);
    }
    rmSync(resolvedFinal, { recursive: true, force: true });
  }
  renameSync(stagingDir, resolvedFinal);
}

export function cleanupDir(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function fileSize(path) {
  return statSync(path).size;
}

export function relativeToRepo(path) {
  return relative(REPO_ROOT, resolve(path));
}
