import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isMainThread } from 'node:worker_threads';

/**
 * FV-P4C-2B3B — exclusive execution of the FV bootstrap path, by operating-system file locks on the
 * write path itself (not composed into the running Host).
 *
 * **Mechanism.** Each file the executor writes is opened with SQLite `locking_mode = EXCLUSIVE` and
 * an exclusive lock taken at once: the protected record and intent store, and every admitted history.
 * SQLite's exclusive lock is a POSIX write lock on the file's SHARED byte range, held by this process
 * until the connection closes or the process dies. While it is held, no other connection in any
 * process can read or write the file. So no second executor can commit, and a stale one cannot
 * exist: authority is not a timestamp that expires while its holder still runs.
 * - **Process death** releases the lock: a restarted Host acquires it.
 * - **A hung process** keeps it: a new Host fails closed (`EXECUTOR_HELD`), and never assumes authority
 *   while the old writer can still commit.
 * - **Clock changes** do not matter: no lock decision reads a clock.
 *
 * **The hazard, and the fence.** POSIX record locks belong to the process, and closing *any*
 * descriptor of a file drops them all, whatever SQLite believes. A raw `open`/`close` of a held
 * database inside this process, or the garbage collection of its connection, would silently end the
 * exclusivity while SQLite went on writing as if it held it, and another Host could then acquire it.
 * Therefore:
 * 1. Nothing in the composition opens a held file except through its one connection, and every
 *    connection is held for the composition's lifetime.
 * 2. Every write is fenced. `confirmExclusivelyHeld` runs **synchronously immediately before** each
 *    write transaction. It asks the kernel (`/proc/locks`) whether **this process** holds a POSIX write
 *    lock over SQLite's whole SHARED range on the very inode the configured path names now. It reads
 *    metadata only and opens no database file. It distinguishes this process's lock from another
 *    Host's, which a "can another process open it" probe cannot. Both the check and better-sqlite3's
 *    transactions are synchronous, so nothing in this process can run between them.
 *
 * **Platform.** This needs Linux's `/proc/locks`. Elsewhere (macOS, Windows) exclusivity cannot be
 * confirmed, so the composition refuses to start (`PLATFORM_UNSUPPORTED`). Network filesystems whose
 * POSIX locks are not coherent across hosts are outside the supported deployment.
 *
 * **Closing is a write too (release review C1).** A connection in exclusive WAL mode checkpoints its
 * own view of the WAL into the database and unlinks the WAL when it closes, and better-sqlite3 closes
 * every open connection when the process exits. A process that lost its lock would do that into the
 * files another Host now owns. So an exclusive connection closes only through `exclusiveCloser`:
 * - it is closed only if this process holds its lock at that very moment (checked synchronously);
 * - otherwise it is **retained, never closed**;
 * - at process exit, if any retained or open exclusive connection's lock is not held, the process kills
 *   itself (`SIGKILL`) before the native cleanup can checkpoint. A Host that lost its authority stops,
 *   it does not shut down gracefully.
 *
 * **What it does not do.** A raw writer of the file or its directory, outside SQLite, is not stopped
 * by SQLite locks. That is `checkProtectedFile`'s job, and the deployment's (owner-only paths), and
 * beyond them FV-P4D's.
 */

/** SQLite's lock bytes (os_unix.c): the SHARED range an EXCLUSIVE lock write-locks in full. */
const SHARED_FIRST = 1073741824n + 2n;
const SHARED_LAST = SHARED_FIRST + 510n - 1n;

/**
 * Whether exclusivity can be held and confirmed here: Linux, and the **main thread** only. A worker
 * thread's teardown (`terminate()`, or the process exiting under it) closes its connections, and so
 * checkpoints them, without the exit guard ever running (review R2-H). So no exclusive connection is
 * ever opened off the main thread.
 */
export function exclusivitySupported(): boolean {
  if (process.platform !== 'linux' || !isMainThread) return false;
  try {
    readFileSync('/proc/locks', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** `MAJOR:MINOR:INODE` as `/proc/locks` prints it (hex device numbers, decimal inode). */
function lockKeyOf(path: string): string | undefined {
  try {
    const st = statSync(path, { bigint: true });
    if (!st.isFile() || st.ino === 0n) return undefined;
    const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
    const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
    return `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Whether **this process** holds SQLite's exclusive lock on every one of `paths`, as the files those
 * paths name right now. `false` for anything else: unsupported platform, unreadable, another holder,
 * no lock, a partial lock, or a path that now names another file.
 */
export function confirmExclusivelyHeld(paths: readonly string[]): boolean {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((p) => typeof p !== 'string' || p === '')) return false;
  if (process.platform !== 'linux' || !isMainThread) return false;
  let table: string;
  try {
    table = readFileSync('/proc/locks', 'utf8');
  } catch {
    return false;
  }
  const pid = String(process.pid);
  const held = new Set<string>();
  for (const line of table.split('\n')) {
    // `N: POSIX ADVISORY WRITE PID MAJ:MIN:INODE START END`; a `->` line is a waiter, never a holder.
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields.includes('->')) continue;
    const [, kind, , access, owner, key, start, end] = fields;
    if (kind !== 'POSIX' || access !== 'WRITE' || owner !== pid || key === undefined || start === undefined || end === undefined) continue;
    let first: bigint;
    let last: bigint | undefined;
    try {
      first = BigInt(start);
      last = end === 'EOF' ? undefined : BigInt(end);
    } catch {
      continue;
    }
    if (first <= SHARED_FIRST && (last === undefined || last >= SHARED_LAST)) held.add(key);
  }
  return paths.every((p) => {
    const key = lockKeyOf(resolve(p));
    return key !== undefined && held.has(key);
  });
}

/**
 * FV-P4C-2B3C-3 — whether **another** process holds a POSIX write lock on the file `path` names now (for
 * telling a store held by a still-living executor from one refused for any other reason). Reads metadata
 * only; `false` when unknown.
 */
export function heldByAnotherProcess(path: string): boolean {
  if (typeof path !== 'string' || path === '' || process.platform !== 'linux') return false;
  const key = lockKeyOf(resolve(path));
  if (key === undefined) return false;
  let table: string;
  try {
    table = readFileSync('/proc/locks', 'utf8');
  } catch {
    return false;
  }
  const pid = String(process.pid);
  return table.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 8 || fields.includes('->')) return false;
    const [, kind, , access, owner, lockKey, start, end] = fields;
    if (kind !== 'POSIX' || access !== 'WRITE' || owner === pid || lockKey !== key || start === undefined || end === undefined) return false;
    // SQLite's own exclusive lock only (its whole SHARED range), not any other byte-range lock (review Info).
    try {
      return BigInt(start) <= SHARED_FIRST && (end === 'EOF' || BigInt(end) >= SHARED_LAST);
    } catch {
      return false;
    }
  });
}

/** Every exclusive connection not yet closed cleanly, by file: held strongly, so no garbage collection can close it. */
const OPEN_EXCLUSIVE = new Set<{ readonly file: string }>();
let exitGuardInstalled = false;

function installExitGuard(): void {
  if (exitGuardInstalled) return;
  exitGuardInstalled = true;
  process.on('exit', () => {
    for (const entry of OPEN_EXCLUSIVE) {
      if (!confirmExclusivelyHeld([entry.file])) process.kill(process.pid, 'SIGKILL');
    }
  });
}

/**
 * FV-P4C-2B3C-1 — how many exclusive connections this process has not closed cleanly (open, or retained
 * after their lock was lost). Zero once every one was closed while held.
 */
export function exclusiveConnectionCount(): number {
  return OPEN_EXCLUSIVE.size;
}

/**
 * FV-P4C-2B3C-1 — whether this process may end normally: every exclusive connection it has not closed
 * cleanly still has its lock confirmed held. `false` means that a normal exit's native cleanup could
 * checkpoint into files another executor now owns, and the process must stop by `SIGKILL` instead.
 */
export function exclusiveConnectionsSafe(): boolean {
  for (const entry of OPEN_EXCLUSIVE) {
    if (!confirmExclusivelyHeld([entry.file])) return false;
  }
  return true;
}

/**
 * FV-P4C-2B3B (release review C1) — the only way an exclusive connection is closed. Registers it and
 * returns its close: the connection is closed only while this process holds its lock on `file`;
 * otherwise it is retained (strongly referenced, never closed), and the exit guard stops the process
 * before any closing checkpoint.
 */
export function exclusiveCloser(file: string, connection: { close(): unknown }): () => void {
  const entry = Object.freeze({ file: resolve(file), connection });
  OPEN_EXCLUSIVE.add(entry);
  installExitGuard();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (!confirmExclusivelyHeld([entry.file])) return; // retained: its checkpoint would write files it no longer owns
    OPEN_EXCLUSIVE.delete(entry);
    connection.close();
  };
}

/** Why a protected path is refused. */
export type ProtectedPathRefusal =
  | 'PLATFORM_UNSUPPORTED'
  | 'NOT_CANONICAL'
  | 'NOT_A_REGULAR_FILE'
  | 'LINKED'
  | 'NOT_OWNED'
  | 'WRITABLE_BY_OTHERS'
  | 'DIRECTORY_NOT_PROTECTED'
  | 'UNREADABLE';

const SIDECARS = ['-wal', '-shm', '-journal'] as const;

/**
 * FV-P4C-2B3B — the filesystem policy of one protected database file, its SQLite sidecars and its
 * directory. It reads metadata only (`lstat`, `realpath`) and never opens the file, so it cannot drop a
 * held lock. `undefined` when the policy holds.
 *
 * - **Platform:** Linux only (see above).
 * - **Canonical:** the configured path, resolved, is its own real path: no symlinked component.
 * - **The file:** a regular file, not a symlink, exactly one link, owned by this process's user, not
 *   writable by group or others. Each existing `-wal`, `-shm` or `-journal` sidecar likewise.
 * - **The directory:** a real directory, owned by this process's user, not writable by group or
 *   others, so no one else can create, replace or rename files in it.
 *
 * `allowMissing` accepts an absent file (a store about to be created) if its directory holds.
 */
export function checkProtectedFile(path: string, options: { readonly allowMissing?: boolean } = {}): ProtectedPathRefusal | undefined {
  if (!exclusivitySupported() || typeof process.getuid !== 'function') return 'PLATFORM_UNSUPPORTED';
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) return 'NOT_CANONICAL';
  const uid = process.getuid();
  const file = resolve(path);
  const directory = dirname(file);
  try {
    if (realpathSync(directory) !== directory) return 'NOT_CANONICAL';
    const dir = lstatSync(directory);
    if (!dir.isDirectory()) return 'DIRECTORY_NOT_PROTECTED';
    if (dir.uid !== uid || (dir.mode & 0o022) !== 0) return 'DIRECTORY_NOT_PROTECTED';
  } catch {
    return 'UNREADABLE';
  }
  const checkOne = (candidate: string, required: boolean): ProtectedPathRefusal | undefined => {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return required ? 'UNREADABLE' : undefined;
      return 'UNREADABLE';
    }
    if (stat.isSymbolicLink()) return 'LINKED';
    if (!stat.isFile()) return 'NOT_A_REGULAR_FILE';
    if (stat.nlink !== 1) return 'LINKED';
    if (stat.uid !== uid) return 'NOT_OWNED';
    if ((stat.mode & 0o022) !== 0) return 'WRITABLE_BY_OTHERS';
    return undefined;
  };
  const main = checkOne(file, options.allowMissing !== true);
  if (main !== undefined) return main;
  for (const suffix of SIDECARS) {
    const refused = checkOne(`${file}${suffix}`, false);
    if (refused !== undefined) return refused;
  }
  return undefined;
}
