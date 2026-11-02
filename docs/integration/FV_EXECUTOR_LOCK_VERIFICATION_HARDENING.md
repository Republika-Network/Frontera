# FV-EXEC-LOCK-01 — Linux executor lock verification hardening

**Status: internal and non-operational.** The dedicated FV executor still composes nothing in production,
and no bootstrap is enabled. This increment changes how the executor *observes* its own SQLite locks; it
changes no authority rule.

## 1. Problem
The FV executor holds its protected continuity store, every admitted history and its bootstrap identity
store with SQLite `locking_mode = EXCLUSIVE`. Every write, every close and every process exit is fenced
by `confirmExclusivelyHeld(paths)` (`executor-exclusivity.ts`): this process must hold SQLite's
exclusive POSIX write lock over the whole SHARED byte range of the inode each path names now. A single
negative answer is terminal:
- the composition's `authority()` marks the executor lost for good (`executor-lost`);
- the dedicated executor's lock watch and exit paths end the process by `SIGKILL`;
- the guarded closer retains (never closes) the connection.

PR #258's Linux CI failed once (B3B test 19, `IDENTITY_REFUSED` right after a successful open). That
pointed to false negatives in this check.

## 2. Reproduction environment
Linux 6.18.33.2-microsoft-standard-WSL2, ext4 (`/tmp`), Node 22.23.1, better-sqlite3 12.11.1
(SQLite 3.53.2), page size 4096, the default PID namespace with `/proc` mounted for it. GitHub's Ubuntu
runners showed the same failure once. Docker or other PID namespaces, overlayfs and network filesystems
were **not** available, and are not claimed as tested.

## 3. Root cause (confirmed)
The old check parsed the global `/proc/locks` table. In the kernel (fs/locks.c), that file is a
`seq_file` over **per-CPU** lock lists. Each `read(2)` takes the global lock-list semaphore in
`locks_start`, emits up to one page, releases it in `locks_stop`, and the next read resumes **by
position**. A lock removed earlier in a list between two reads shifts every later entry back by one, so
an entry that was there throughout is skipped. Only other processes' lock churn is needed.

Measured on the environment above (scratch probes, real processes, real SQLite locks):

| Condition | Observations | False negatives |
|---|---|---|
| ~25 KB table (7–11 reads), 6 processes re-taking 360 locks | 6,412 | 17 (0.27%) |
| Same table, no churn | 16,886 | 0 |
| Churn, small table (1.5 KB) | 31,831 | 0 |
| One lock, idle | 504,505 | 0 |
| 3 held files, 6 × 60 churning locks | 12,123 | 114 (0.9%) |
| 3 held files, 10 × 80 churning locks | 5,050 | 102 (2.0%) |

Each miss was a **false negative**, not a lost lock:
- an independent process could not take the lock during a miss (10 of 10 probes refused);
- the lock reappeared on a later read without anything taking it again.

Immediate re-reads missed again in 3 of 17 cases, so a bounded retry would only lower the rate.

**Other hypotheses:**
- **H1 (PID namespace):** `/proc/locks` translates pids into the reader's namespace and hides locks
  whose holder is not visible there. Not the cause here (one namespace), but a real portability limit of
  the old method.
- **H2 (device numbers):** the old major/minor arithmetic matched the kernel's key on ext4; not the
  cause. It is no longer needed.
- **H3/H4 (range, type):** SQLite's exclusive lock is one POSIX `WRITE` line over 1073741826–1073742335,
  in both WAL and rollback-journal mode; parsing was correct.
- **H6 (genuine loss):** a stray open/close of a held file, or garbage collection of an unreferenced
  connection, really drops the lock. Both were reproduced and are reported correctly as losses by both
  methods. The production path keeps its connections strongly referenced and opens no held file.

## 4. The correction
`confirmExclusivelyHeld` now reads the kernel's **per-descriptor** lock view:
1. List this process's descriptors (`/proc/self/fd`). Listing, `readlink` and `fstat` open nothing.
2. Keep only descriptors whose `/proc/self/fd/<n>` link names the path's real path. Reading a link does
   no I/O on that descriptor's filesystem, so an unrelated descriptor on a hung NFS or FUSE mount is never
   touched (independent review, Low finding).
3. Of those, keep the ones whose `fstat` device and inode equal `stat(path)`: an open file of the very
   inode the path names now. A renamed-over path names another inode and is refused.
4. Read `/proc/self/fdinfo/<fd>`. The kernel's `show_fd_locks` prints the locks set **through that open
   file** whose owner is this process's file table *or the open file itself*, under the inode's own
   lock-context spinlock (`ctx->flc_lock`), in one small read: one consistent snapshot of that inode,
   unaffected by other inodes' churn. The "open file itself" case admits OFD and flock locks that
   **another** process sharing the open file description set (reproduced by the review).
5. Accept only a `lock:` line that is `POSIX`, `WRITE`, owned by `process.pid`, and covering SQLite's
   whole SHARED range. These checks, not the kernel's filter alone, carry the guarantee: an OFD line (pid
   `-1`) or an flock line is refused.

`exclusivitySupported()` now requires `/proc/self/fdinfo`, and requires `/proc/self` to name this
process. So a `/proc` mounted for another PID namespace is unsupported, and the composition refuses to
start (`PLATFORM_UNSUPPORTED`). It no longer reads the global `/proc/locks`: it runs inside every fence's
file check, and that read was extra cost and one more way a read error could become a terminal refusal.

**Unchanged:**
- the API, every fence, the guarded closer, the exit guard, `SIGKILL` fail-stop, strong references, the
  main-thread restriction, terminal authority loss, and synchronous checks immediately before
  synchronous transactions;
- no retry, no sleep, no lease, no recovery;
- `heldByAnotherProcess` still reads `/proc/locks`: it only tells `EXECUTOR_HELD` from `IDENTITY_REFUSED`
  after a refused open, and a miss there changes a refusal code, never a permission.

**Why a positive answer is sound.** On a local filesystem, a POSIX lock owned by this process is removed
only by this process (an unlock, or closing any descriptor of the file) or by its death. Network
filesystems that can drop locks are unsupported. Between the synchronous check
and the synchronous transaction nothing else in this thread runs, and nothing in the composition opens a
held file. So "held at the snapshot" means "held at the write".

## 5. Rejected alternatives
- **Bounded `/proc/locks` re-reads (option B):** this lowers the rate but cannot remove it (repeated
  misses were measured), and it adds latency to every miss. It is unnecessary once the observation is
  atomic.
- **A child-process `F_GETLK` probe:** it reports the holder's pid, but costs a process per write fence.
- **A lease or timestamp:** rejected by design. A stale holder could still write.
- **Native `fcntl` bindings:** no requirement justifies a new native dependency.

## 6. Tests
- **New** `tests/fv-exec-lock01-lock-verification.e2e.test.mjs` (10 tests, real processes):
  - 0 false negatives over 2,000 observations (at most 30 s) under heavy churn, with at least 200 required.
    The old method is sampled every 10th observation and its misses printed first, as a diagnostic, not
    asserted. PR #259's first CI run failed this test's original fixed-time floor (267 observations in 15 s
    on a loaded runner), not its false-negative assertion; the floor is now count- and time-bounded;
  - another process's lock, a SHARED read lock, a single-byte RESERVED lock, unlocked, missing and
    non-file paths are all refused;
  - WAL and rollback-journal exclusive locks are both recognized;
  - a path renamed over is refused;
  - a genuine stray-close loss is reported at once, only for that file, and never comes back on re-reads,
    while another process can now take it;
  - 2,000 observations drop nothing.
  - A clearly labelled **simulated** block substitutes `/proc` output in-process: an unreadable
    descriptor list, a `/proc` of another namespace, another device with the same inode number, and lock
    lines for another pid, a partial range (either end), READ, FLOCK, OFD, a waiter, malformed and
    non-numeric lines are all refused.
- **Test harness:** the B3B test child injected its faults by hooking `readFileSync('/proc/locks')`. It
  now wraps the exported `confirmExclusivelyHeld`: "before" faults act before the observation, "after"
  faults right after it returns. `Error.stackTraceLimit` is raised so every observation is attributed to
  its write; the old attribution depended on V8's 10-frame default. An `after:X` crash fires at the first
  observation of anything else. The B3B, B3C-1 and B3C-3 crash, drop and settle-race tests pass with
  their assertions unchanged.
- **Fail-stop and WAL:** covered by the existing real-process tests, run here: B3B 16 (an old process
  whose locks were dropped after a takeover writes nothing, and its close and exit cannot undo the new
  holder), B3C-1 22–25 and 22 (a stale executor's shutdown is a fail-stop without any close; the new
  holder's state survives), and the B3C-3 identity-lock cases.

## 7. Independent review
A read-only AI review of the diff (same model family; **not a human review**) found no false positive and
nothing Critical or High. It reproduced against real processes: another process's lock, a child's POSIX
lock and OFD lock through a shared open file description, rename, close, symlink and hard link (refused by
`checkProtectedFile` as before), and both PID-namespace cases (`unshare -Urpf` with the parent's `/proc`:
refused as unsupported; `--mount-proc`: supported and confirmed). It also checked the kernel claims
against fs/locks.c, and traced the harness's death points in real runs (unchanged or stricter).

| Finding | Severity | Resolution |
|---|---|---|
| Every fence `fstat`ed every descriptor; one on a hung NFS or FUSE mount could stall the event loop; cost grows with descriptors | Low | Fixed: descriptors are pre-filtered by their `/proc/self/fd` link (no target I/O); tested (simulated) that unrelated descriptors are never `fstat`ed; mutant killed |
| The comment said the kernel filters fdinfo to this process; OFD and flock locks set by another process through a shared open file description appear too (reproduced; still refused by the type check) | Low | Fixed: comments and this doc state the exact filter, and that the `POSIX` and pid checks carry the guarantee |
| Refusal messages still named `/proc/locks` | Info | Fixed |
| `exclusivitySupported` does not check that the kernel prints `lock:` lines (an old kernel or gVisor fails closed as executor-lost, not `PLATFORM_UNSUPPORTED`) | Info | Accepted: fails closed; documented |
| `exclusivitySupported` re-read the whole `/proc/locks` in every fence | Info | Fixed: no longer read there |
| A descriptor could be reused between `fstat` and the fdinfo read | Info | Accepted: a false positive would need another thread to reuse it for a different SQLite-locked file of this process; SQLite runs on the main thread only and nothing dups |
| The harness wraps only cross-module calls (closer, exit guard and `exclusiveConnectionsSafe` are no longer injection points); B3C-1's `crashLeaving` cannot see that the kill point was reached | Low (test) | Accepted and documented; no current kill or drop point depends on them, and B3B checks the kill point was reached |

## 8. Mutation testing
16 targeted mutants of `executor-exclusivity.js`, in an isolated copy, with bounded timeouts and the
file restored and hash-verified:
- **15 killed:**
  - the parser and identity checks: any pid, ignoring the device, ignoring the inode, a partial range
    (either end), any lock type, read locks, a descriptor error treated as success, an unreadable listing
    treated as success, the foreign-`/proc` check removed, the descriptor pre-filter removed;
  - the old `/proc/locks` observation restored (killed by the churn test);
  - the guarded close removed, and the exit guard removed (both killed by the B3B and B3C-1 fail-stop
    tests);
  - `confirmExclusivelyHeld` always true.
- **1 equivalent:** accepting `->` waiter lines. The kernel's fdinfo never prints waiters
  (`show_fd_locks` lists granted locks only), and a `->` line's fields shift so the type check still
  rejects it (tested).

## 9. Remaining limits
- **Environment:** tested on one WSL2 kernel with ext4. Containers with their own PID namespace and
  `/proc` should work (`/proc/self` names the process, and ownership is decided by the kernel), but are
  untested. A foreign `/proc` is refused. overlayfs and network filesystems are untested; network
  filesystems remain unsupported.
- **Cost:** each check lists the process's descriptors and reads one `/proc` link per descriptor
  (`O(fds)`; the review measured the pre-filter-less version at ~0.15 ms with few descriptors and ~18 ms
  with 10,000). A dedicated executor holds a few dozen.
- **Paths:** a file is matched by its real path as the descriptor's link shows it. A held file reached
  through another bind-mount path is not matched (fails closed). The composition opens and checks the
  same canonical path.
- **Kernels without fdinfo lock lines** (very old kernels, gVisor) pass the platform check but never
  confirm a lock: they fail closed, reported as authority lost rather than `PLATFORM_UNSUPPORTED`.
- **What it does not fix:** genuine locks lost through a stray descriptor in the process are still
  terminal, by design. The B3C-1 supervisor still treats a fail-stopped executor as a crash.
- **`/proc/locks` remains** in `heldByAnotherProcess` (refusal classification only).
- **Not operational:** deployment isolation, B3C-2, B6 and FV-P4D remain open.
