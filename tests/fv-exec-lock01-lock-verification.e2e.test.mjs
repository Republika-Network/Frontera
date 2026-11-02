// FV-EXEC-LOCK-01 — the executor's lock verification observes this process's own SQLite exclusive locks
// through /proc/self/fdinfo, one consistent per-inode snapshot filtered by the kernel to this process, instead
// of the global /proc/locks table, whose page-by-page reads skip entries under other processes' lock churn.
// Real SQLite, real child processes, temporary databases only. Linux only.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { confirmExclusivelyHeld, exclusivitySupported } from '../dist/src/enterprise/sovereign-status-history/executor-exclusivity.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const SQLITE = require.resolve('better-sqlite3');
const linux = process.platform === 'linux';

const dirs = [];
const kids = new Set();
const held = [];
after(() => {
  for (const kid of kids) kid.kill('SIGKILL');
  // A connection whose lock a test deliberately dropped is never closed (it would checkpoint); the rest close.
  for (const { db, lost } of held) if (!lost) db.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'fv-exec-lock01-'));
  dirs.push(dir);
  return dir;
}

/** An exclusively held SQLite database (WAL, locking_mode EXCLUSIVE, lock taken at once), strongly referenced. */
function holdExclusive(path, { wal = true } = {}) {
  const db = new Database(path);
  if (wal) db.pragma('journal_mode = WAL');
  db.pragma('locking_mode = EXCLUSIVE');
  db.exec('BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS t(x); COMMIT');
  const entry = { db, lost: false };
  held.push(entry);
  return entry;
}

/** Child processes that hold and constantly re-take many exclusive locks: other processes' lock churn. */
async function churn(dir, processes, perProcess) {
  const script = `const D=require(${JSON.stringify(SQLITE)});const p=require('node:path');const [dir,n,per]=[process.argv[1],process.argv[2],+process.argv[3]];const dbs=[];for(let i=0;i<per;i++){const d=new D(p.join(dir,'churn-'+n+'-'+i+'.sqlite'));d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE; COMMIT');dbs.push(d);}process.stdout.write('up\\n');(function loop(){for(let k=0;k<20;k++){const i=Math.floor(Math.random()*per);dbs[i].close();const d=new D(p.join(dir,'churn-'+n+'-'+i+'.sqlite'));d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE; COMMIT');dbs[i]=d;}setImmediate(loop);})();`;
  const started = Array.from({ length: processes }, (_, n) => {
    const kid = spawn(process.execPath, ['-e', script, dir, String(n), String(perProcess)], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(kid);
    return kid;
  });
  await Promise.all(started.map((kid) => new Promise((done) => kid.stdout.once('data', done))));
  return () => {
    for (const kid of started) {
      kid.kill('SIGKILL');
      kids.delete(kid);
    }
  };
}

/** Whether a separate process can take the exclusive lock of `path` right now (it never writes). */
function anotherProcessCanTake(path) {
  const script = `const D=require(${JSON.stringify(SQLITE)});try{const d=new D(process.argv[1]);d.pragma('busy_timeout = 0');d.exec('BEGIN EXCLUSIVE');d.exec('ROLLBACK');d.close();console.log('ACQUIRED')}catch{console.log('REFUSED')}`;
  return spawnSync(process.execPath, ['-e', script, path], { encoding: 'utf8', timeout: 15_000 }).stdout.trim() === 'ACQUIRED';
}

/** The pre-fix observation (the global /proc/locks table), kept here only to show the fault this replaces. */
function heldInProcLocks(path) {
  const st = statSync(path, { bigint: true });
  const major = ((st.dev >> 8n) & 0xfffn) | ((st.dev >> 32n) & ~0xfffn);
  const minor = (st.dev & 0xffn) | ((st.dev >> 12n) & ~0xffn);
  const key = `${major.toString(16).padStart(2, '0')}:${minor.toString(16).padStart(2, '0')}:${st.ino}`;
  return readFileSync('/proc/locks', 'utf8')
    .split('\n')
    .some((line) => {
      const f = line.trim().split(/\s+/);
      return f.length >= 8 && !f.includes('->') && f[1] === 'POSIX' && f[3] === 'WRITE' && f[4] === String(process.pid) && f[5] === key && BigInt(f[6]) <= 1073741826n && (f[7] === 'EOF' || BigInt(f[7]) >= 1073742335n);
    });
}

describe('FV-EXEC-LOCK-01 — lock verification without false negatives, and without false positives', { skip: !linux && 'Linux only' }, () => {
  it('the environment is supported: Linux, main thread, /proc/self/fdinfo, and /proc of this process’s own PID namespace', () => {
    assert.equal(exclusivitySupported(), true);
  });

  it('a held lock is confirmed on every observation under heavy lock churn by other processes, where the old /proc/locks reading misses it', { timeout: 120_000 }, async () => {
    const dir = directory();
    const paths = [0, 1, 2].map((i) => join(dir, `held-${String(i)}.sqlite`));
    for (const path of paths) holdExclusive(path);
    const stop = await churn(dir, 8, 70);
    try {
      let observations = 0;
      let missed = 0;
      let oldMissed = 0;
      const end = Date.now() + 15_000;
      while (Date.now() < end) {
        observations += 1;
        if (!confirmExclusivelyHeld(paths)) missed += 1;
        if (!paths.every(heldInProcLocks)) oldMissed += 1;
      }
      assert.ok(observations > 500, String(observations));
      assert.equal(missed, 0, `${String(missed)} false negatives in ${String(observations)} observations`);
      // Diagnostic only (not asserted: it depends on the machine's load): how often the replaced reading missed.
      process.stdout.write(`# FV-EXEC-LOCK-01 observations=${String(observations)} newMisses=${String(missed)} oldProcLocksMisses=${String(oldMissed)}\n`);
      // The locks were genuinely held throughout: another process cannot take them.
      assert.equal(anotherProcessCanTake(paths[0]), false);
    } finally {
      stop();
    }
  });

  it('only this process’s exclusive lock on the very inode counts: another process’s lock, a read lock, a single-byte write lock, an unlocked file and a missing one are refused', async () => {
    const dir = directory();
    // Another process's exclusive lock on a file this process has open too (unlocked).
    const foreign = join(dir, 'foreign.sqlite');
    const kid = spawn(process.execPath, ['-e', `const D=require(${JSON.stringify(SQLITE)});const d=new D(process.argv[1]);d.pragma('locking_mode = EXCLUSIVE');d.exec('BEGIN EXCLUSIVE; CREATE TABLE t(x); COMMIT');process.stdout.write('up\\n');setInterval(()=>{},1000);`, foreign], { stdio: ['ignore', 'pipe', 'ignore'] });
    kids.add(kid);
    await new Promise((done) => kid.stdout.once('data', done));
    assert.equal(confirmExclusivelyHeld([foreign]), false, 'another process holds it');
    // A SHARED lock (a read transaction, rollback journal, normal locking): a POSIX read lock, not exclusivity.
    const shared = join(dir, 'shared.sqlite');
    const reader = new Database(shared);
    reader.exec('CREATE TABLE t(x)');
    reader.exec('BEGIN');
    reader.prepare('SELECT count(*) FROM t').get();
    assert.equal(confirmExclusivelyHeld([shared]), false, 'a read lock');
    reader.exec('COMMIT');
    // A RESERVED lock (BEGIN IMMEDIATE, rollback journal): a write lock on one byte outside the SHARED range.
    reader.exec('BEGIN IMMEDIATE');
    assert.equal(confirmExclusivelyHeld([shared]), false, 'a single-byte write lock');
    reader.exec('ROLLBACK');
    reader.close();
    // No lock at all, a missing file, a non-file.
    writeFileSync(join(dir, 'plain'), '');
    assert.equal(confirmExclusivelyHeld([join(dir, 'plain')]), false);
    assert.equal(confirmExclusivelyHeld([join(dir, 'missing.sqlite')]), false);
    assert.equal(confirmExclusivelyHeld([dir]), false);
    // Malformed input.
    for (const input of [[], [''], [1], 'x', undefined]) assert.equal(confirmExclusivelyHeld(input), false, JSON.stringify(input));
    // A held lock beside a refused one: all must hold.
    const mine = join(dir, 'mine.sqlite');
    holdExclusive(mine);
    assert.equal(confirmExclusivelyHeld([mine]), true);
    assert.equal(confirmExclusivelyHeld([mine, foreign]), false);
    kid.kill('SIGKILL');
    kids.delete(kid);
  });

  it('the rollback-journal exclusive lock counts as well as the WAL one (both are SQLite’s exclusive lock)', () => {
    const dir = directory();
    holdExclusive(join(dir, 'journal.sqlite'), { wal: false });
    holdExclusive(join(dir, 'wal.sqlite'));
    assert.equal(confirmExclusivelyHeld([join(dir, 'journal.sqlite'), join(dir, 'wal.sqlite')]), true);
  });

  it('a path that names another file now is refused, although the replaced inode is still locked by this process', () => {
    const dir = directory();
    const path = join(dir, 'held.sqlite');
    holdExclusive(path);
    assert.equal(confirmExclusivelyHeld([path]), true);
    writeFileSync(join(dir, 'other'), '');
    renameSync(join(dir, 'other'), path);
    assert.equal(confirmExclusivelyHeld([path]), false);
  });

  it('a genuine loss — a stray open/close of the held file drops this process’s POSIX lock — is reported at once, and only for that file; another process can then take it', () => {
    const dir = directory();
    const lostPath = join(dir, 'lost.sqlite');
    const keptPath = join(dir, 'kept.sqlite');
    const lost = holdExclusive(lostPath);
    holdExclusive(keptPath);
    assert.equal(confirmExclusivelyHeld([lostPath, keptPath]), true);
    closeSync(openSync(lostPath, 'r'));
    // This connection lost its lock: it must never be closed normally (its close would checkpoint).
    lost.lost = true;
    assert.equal(confirmExclusivelyHeld([lostPath]), false);
    assert.equal(confirmExclusivelyHeld([lostPath, keptPath]), false);
    assert.equal(confirmExclusivelyHeld([keptPath]), true);
    assert.equal(anotherProcessCanTake(lostPath), true, 'the lock was really gone');
    assert.equal(anotherProcessCanTake(keptPath), false);
    // Repeated observations never bring a lost lock back.
    for (let i = 0; i < 200; i += 1) assert.equal(confirmExclusivelyHeld([lostPath]), false);
  });

  // SIMULATED kernel output: the cases below substitute what /proc returns, in this process, through the same `fs`
  // module the verification reads it with. They cover refusals the real kernel cannot be made to produce here
  // (another device with the same inode number, an flock or OFD line, a partial range, a foreign /proc).
  describe('simulated observation inputs (substituted /proc output; never a real kernel state)', () => {
    const fs = require('node:fs');
    const withPatched = (name, replacement, body) => {
      const original = fs[name];
      fs[name] = replacement(original);
      try {
        return body();
      } finally {
        fs[name] = original;
      }
    };

    it('an unreadable descriptor list, or a /proc of another PID namespace, is never success', () => {
      const dir = directory();
      const path = join(dir, 'held.sqlite');
      holdExclusive(path);
      assert.equal(confirmExclusivelyHeld([path]), true);
      const unreadable = (original) => (target, ...rest) => {
        if (target === '/proc/self/fd') throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return original.call(fs, target, ...rest);
      };
      assert.equal(withPatched('readdirSync', unreadable, () => confirmExclusivelyHeld([path])), false);
      const foreignProc = (original) => (target, ...rest) => (target === '/proc/self' ? String(process.pid + 1) : original.call(fs, target, ...rest));
      assert.equal(withPatched('readlinkSync', foreignProc, () => exclusivitySupported()), false);
      assert.equal(exclusivitySupported(), true);
    });

    it('review Low: no unrelated descriptor is ever fstat’d (one on a hung mount could block the fence); only those whose link names the file', () => {
      const dir = directory();
      const path = join(dir, 'held.sqlite');
      holdExclusive(path);
      // Plenty of unrelated descriptors (stand-ins for a log file on a hung NFS/FUSE mount).
      const unrelated = Array.from({ length: 20 }, (_, i) => openSync(join(dir, `unrelated-${String(i)}`), 'w'));
      const statted = [];
      const recording = (original) => (fd, ...rest) => {
        statted.push(fd);
        return original.call(fs, fd, ...rest);
      };
      try {
        assert.equal(withPatched('fstatSync', recording, () => confirmExclusivelyHeld([path])), true);
        assert.ok(statted.length >= 1);
        for (const fd of statted) assert.equal(fs.readlinkSync(`/proc/self/fd/${String(fd)}`), path, `fd ${String(fd)} was examined`);
        for (const fd of unrelated) assert.equal(statted.includes(fd), false);
      } finally {
        for (const fd of unrelated) closeSync(fd);
      }
    });

    it('a descriptor on another device with the same inode number is not the file', () => {
      const dir = directory();
      const path = join(dir, 'held.sqlite');
      holdExclusive(path);
      const otherDevice = (original) => (fd, ...rest) => {
        const real = original.call(fs, fd, ...rest);
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { dev: real.dev + 1n });
      };
      assert.equal(withPatched('fstatSync', otherDevice, () => confirmExclusivelyHeld([path])), false);
      // And a descriptor whose link names the path but which is another inode (a mount alias) is not the file either.
      const otherInode = (original) => (fd, ...rest) => {
        const real = original.call(fs, fd, ...rest);
        return Object.assign(Object.create(Object.getPrototypeOf(real)), real, { ino: real.ino + 1n });
      };
      assert.equal(withPatched('fstatSync', otherInode, () => confirmExclusivelyHeld([path])), false);
      assert.equal(confirmExclusivelyHeld([path]), true);
    });

    it('only a POSIX write lock of this pid over the whole SHARED range counts: every other line is refused', () => {
      const dir = directory();
      const path = join(dir, 'held.sqlite');
      holdExclusive(path);
      const st = statSync(path, { bigint: true });
      const key = `00:00:${String(st.ino)}`;
      const pid = String(process.pid);
      const fdinfo = (lines) => (original) => (target, ...rest) => (typeof target === 'string' && target.startsWith('/proc/self/fdinfo/') ? `pos:\t0\nflags:\t02500002\nmnt_id:\t1\nino:\t${String(st.ino)}\n${lines.map((l) => `lock:\t${l}\n`).join('')}` : original.call(fs, target, ...rest));
      const verdict = (lines) => withPatched('readFileSync', fdinfo(lines), () => confirmExclusivelyHeld([path]));
      assert.equal(verdict([`1: POSIX  ADVISORY  WRITE ${pid} ${key} 1073741826 1073742335`]), true, 'the genuine line (sanity)');
      assert.equal(verdict([`1: POSIX  ADVISORY  WRITE ${pid} ${key} 1073741824 EOF`]), true, 'a wider range still covers it');
      const refused = {
        'another pid': `1: POSIX  ADVISORY  WRITE ${String(process.pid + 1)} ${key} 1073741826 1073742335`,
        'a range starting inside the SHARED range': `1: POSIX  ADVISORY  WRITE ${pid} ${key} 1073741827 1073742335`,
        'a range ending inside it': `1: POSIX  ADVISORY  WRITE ${pid} ${key} 1073741826 1073742334`,
        'a read lock': `1: POSIX  ADVISORY  READ  ${pid} ${key} 1073741826 1073742335`,
        'an flock lock': `1: FLOCK  ADVISORY  WRITE ${pid} ${key} 0 EOF`,
        'an OFD lock': `1: OFDLCK ADVISORY  WRITE -1 ${key} 1073741826 1073742335`,
        'a waiter': `1: -> POSIX  ADVISORY  WRITE ${pid} ${key} 1073741826 1073742335`,
        'a malformed line': `1: POSIX ADVISORY WRITE ${pid}`,
        'non-numeric bounds': `1: POSIX  ADVISORY  WRITE ${pid} ${key} x y`,
      };
      for (const [label, line] of Object.entries(refused)) assert.equal(verdict([line]), false, label);
      assert.equal(verdict([]), false, 'no lock line at all');
    });
  });

  it('the observation opens no database file, so it cannot itself drop a held lock', () => {
    const dir = directory();
    const path = join(dir, 'held.sqlite');
    holdExclusive(path);
    for (let i = 0; i < 2_000; i += 1) assert.equal(confirmExclusivelyHeld([path]), true);
    assert.equal(anotherProcessCanTake(path), false);
  });
});
