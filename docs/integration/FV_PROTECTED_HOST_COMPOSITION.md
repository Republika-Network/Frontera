# FV-P4C-2B3B — Protected FV Host composition

**Status: internal and non-operational.** Nothing in `src/` outside the FV module, nor any script,
route, CLI or startup path, reaches this composition. Structure tests pin this. Bootstrap execution is
**disabled** unless the trusted composition passes a status source, and the running Host has none
(B6). This increment does not activate anything.

**Release status: not production-ready.** Before any activation:
- **A dedicated FV executor process is REQUIRED (§5).** FV-P4C-2B3C-1 adds its runtime, lifecycle and
  supervisor, non-operational (`FV_DEDICATED_EXECUTOR_LIFECYCLE.md`); the deployment isolation it still
  needs is not implemented.
- **Identity ownership: FV-P4C-2B3C-3** (`FV_AUTH03_IDENTITY_OWNERSHIP.md`). The composition opens and
  exclusively holds its own bootstrap identity store (it no longer takes a store handed in), and the
  settlement write is fenced inside that store's transaction, closing the I3 non-atomic window (§11).
  Its CORE-07 witness slot of its own exists since CORE-07-FV-WITNESS (`fv-bootstrap-identity-state`,
  `CORE07_FV_INDEPENDENT_FRESHNESS_DOMAINS.md`); activation still needs the FV registration ceremony.
- **A compromised filesystem writer running as the same user (or root) is outside current
  protection (§8).**
- **Whole-system rollback detection remains an FV-P4D dependency (§12).**

It builds on FV-P4C-2B3A (`FV_HOST_COMPOSITION_FOUNDATIONS.md`) and closes the gaps B3A left to B3B:
- F4: the Host operation held a writable handle;
- L1: the gate was checked at call time only;
- N5/F6: the custody predicate was caller-supplied;
- protected storage was an interface only;
- there was no exclusive-executor lease.

## 1. Verified architecture (main `c2152dfc`)

| Component | Contract found | Role here |
|---|---|---|
| AUTH-03 `createHumanIdentityServiceWithBootstrapSettlement` | Issues `{ service, settlementCapability }`; the capability is instance-bound and revocable; `isBootstrapSettlementCapabilityOf` is exact | Issued **inside** the composition, over the identity store it is handed |
| AUTH-04A `composeHumanAuthority` | Composes one plain `createHumanIdentityService`; does not issue the capability (pinned by B3A) | **Unchanged.** Wiring both onto one store is an activation step |
| CORE-05 approval channel | `human-decision.ts` never names the bootstrap domain (pinned by B2B) | Unchanged |
| Kernel-Authority standing | `BootstrapStandingPort`, adapted by `createKernelAuthorityBootstrapPermissions` | The composition takes the standing port and builds the permissions itself |
| FV human-decision authorizer | Consumes two AUTH-03 decisions through a `BootstrapHumanDecisionPort` | Built per call, over the boundary's gated port only |
| FV coordinator | `coordinateStatusHistoryBootstrap(request, signedStatus, context)`; the commit is the store's single evidence transaction, re-read after | Invoked **by the composition** |
| FV authority boundary, operation registry, Host inventory, continuity records | B3A | Composed, never exposed |
| FV SQLite history store | WAL + `synchronous = FULL`, integrity triggers, per-handle identity checks | Gains an opt-in `exclusive` open and a `beforeWrite` fence |
| PROD-02 store registration, backup and restore | Registry of the Host's stores | **Not touched** (B3C) |
| Process locks or leases | **None existed** in the repository | New: `executor-exclusivity.ts` |

## 2. Dependency diagram

```
composeFvProtectedHost (protected-host-composition.ts)       ← reached by nothing at runtime
 ├─ executor-exclusivity.ts    checkProtectedFile · confirmExclusivelyHeld (/proc/locks)
 ├─ protected-continuity-store.ts   exclusive SQLite: records · intents · epoch
 ├─ host-inventory.ts (exclusive)   ── history-continuity.ts ── sqlite store (exclusive, fenced)
 ├─ ../human-identity/index.js      createHumanIdentityServiceWithBootstrapSettlement,
 │                                  isBootstrapSettlementCapabilityOf, revokeBootstrapSettlementCapability
 ├─ authority-boundary.ts           gated decisions · in-flight registry · reconciler
 ├─ authority-permissions.ts        Kernel-Authority standing → permissions
 ├─ human-decision-authorizer.ts    per call
 └─ bootstrap-coordinator.ts        the one write path
```

The composition is the only file of the FV module that imports AUTH-03, and only its index. The B2
structure test carries exactly this one-file exception.

## 3. Trust model

| Principal / component | Reads | Writes | Holds | Must never receive | Persists |
|---|---|---|---|---|---|
| Host composition root (`composeFvProtectedHost`) | configuration, all FV state | through the components below | the capability, every handle, the boundary | — | nothing itself |
| AUTH-03 identity store owner | its store | its store | the store | — | identity history (CORE-07 witnessed when composed by AUTH-04A). Since B3C-3, the FV bootstrap identity store's owner is this composition, exclusively. |
| Bootstrap requester / independent approver | their own challenge | a signed WebAuthn response | a passkey | the service, the capability, any handle | the decision, in AUTH-03 |
| Kernel-Authority | standing | — | grants | — | its own world |
| FV coordinator | the request, the status, the history | **the history's one evidence transaction** | a history handle, for one call | the capability, the protected store | evidence in the history |
| FV reconciler | AUTH-03 unsettled decisions, admitted histories | AUTH-03 settlements through the capability | the capability's port | the raw service, the store | settlements in AUTH-03 |
| FV history owner (the executor) | its files | its files, fenced | exclusive locks | — | the history files |
| Protected record and intent store | records, intents | records, intents, epoch, fenced | its exclusive lock (**the executor's authority**) | — | records, intents, epochs |
| Exclusive executor | the kernel's lock table | — | OS locks of the files above | — | nothing: released at death |
| Untrusted callers and adapters | — | data only: request, signed status, signed decisions | nothing | code paths, handles, capability, predicate | — |
| Future issuer status source (B6) | — | an attestation | — | handles | — |

**Signed intent is not an outcome.** The humans' signed decisions authorize a binding. Whether that
binding was committed is proven only by the history's own evidence, read through the store's
validators. A decision never settles `bootstrap-committed` without evidence. It never settles
`bootstrap-not-committed` while its history is quarantined, or while it might still commit.

## 4. Protected durable storage (`protected-continuity-store.ts`)

- **One SQLite file**, in WAL mode with `synchronous = FULL`. Every write transaction's WAL frame is
  synced before the method returns.
- **Exclusive.** `locking_mode = EXCLUSIVE` is set before the first access, and the lock is taken at
  once.
- **Schema `frontera.fv-protected-continuity-store/1`:**
  - meta: the schema and a **monotonic epoch**;
  - records: one per namespace;
  - intents: `(namespace, request id)`, with the binding, a `pending`/`completed` state, the epoch that
    began it, and timestamps.
- **Triggers** forbid:
  - deleting records, intents or meta;
  - changing an intent's identity;
  - completing an intent twice, or re-opening one;
  - lowering the epoch.
- **Open:**
  - never creates a file unless `create`, and `create` over an existing file is refused;
  - `quick_check`, exactly these tables and triggers, and the schema version are checked;
  - a non-WAL file is refused rather than converted;
  - the epoch is incremented durably (fenced) before the store is returned.
- **Every row is validated when it is read:**
  - a malformed record is returned as stored, so the assessment classifies it `RECORD_INVALID`;
  - a malformed intent row throws, so the namespace is `UNAVAILABLE` (never "no intent").
- **`beginIntent`:**
  - the same pending intent again is a no-op;
  - any other existing row for that request id is a `CONFLICT`, never overwritten.
- **`completeIntent`:** exactly one pending row becomes completed, or `CONFLICT`.
- **Ambiguous outcomes.** A throw may still have reached the disk. Callers treat it as "maybe
  written":
  - a failed `beginIntent` refuses the consumption, and a possibly-pending intent then quarantines its
    namespace;
  - a failed `completeIntent` leaves the intent pending.

  Nothing fabricates success or failure.

### Durable write order (one bootstrap)

1. **Validate:** the input is read once as data, the request is parsed, the trusted subject resolved,
   and the run registered in flight (namespace, binding).
2. **Executor authority:** the inventory admits the history, then `confirmHeld` (both locks).
3. **`beginIntent`:** durable and fenced, inside the gated `authorize`, before AUTH-03 consumes
   anything.
4. **AUTH-03 consumes** the snapshot it was gated on.
5. **The coordinator runs:** status, authority, source, then the history's evidence transaction
   (fenced).
6. **The coordinator re-reads** the commit. Then `hasBootstrapRequest`, the M1 guard, and
   `confirmHeld` again.
7. **`save(record)`:** the re-captured checkpoint, durable and fenced, if there is evidence.
8. **`completeIntent`:** durable and fenced, only if:
   - there is no evidence and this handle never committed it; or
   - there is evidence and the record was re-captured.
9. **Release:** the run's registration and running count drop. The locks stay with the executor until
   `close()`.
10. **`reconcile()`** settles AUTH-03 from the admitted, held histories' evidence only:
    - executor authority is confirmed at its start;
    - each snapshot admits only histories still held;
    - immediately before **every** settlement write, the boundary's `settlementGuard` confirms authority
      again (final review I3).

Every crash between these steps is exercised by a real `SIGKILL` (§9).

## 5. Exclusive executor and fencing (`executor-exclusivity.ts`)

**Evaluated and rejected:**
- **A timestamp lease.** It expires while a hung holder can still commit, and the database write path
  cannot enforce it.
- **An epoch alone.** The history write path has no column to fence on, and the history schema is not
  changed here.
- **A probe asking whether another process can open the file.** It cannot tell this process's lock
  from another Host's: a stale process would read a new holder's lock as its own.

**Chosen: OS file locks on the write path itself, confirmed from the kernel before every write.**
- **The exclusive lock.** Each file the executor writes (the protected store and every admitted history)
  is opened with SQLite `locking_mode = EXCLUSIVE`, and `BEGIN EXCLUSIVE; COMMIT` takes the lock at once
  with `busy_timeout = 0`. SQLite holds a POSIX write lock over the file's SHARED byte range until the
  connection closes or the process dies, and no other connection can read or write.
- **The protected store's lock is the executor's authority.** A second Host fails at once with
  `EXECUTOR_HELD`. It never waits and never assumes authority while the first lives, whatever either
  clock says.
- **Process death** releases the lock: a restart acquires it. Each acquisition's epoch is recorded on
  the intents it begins.
- **The POSIX hazard.** Closing *any* descriptor of a file drops all of this process's locks on it,
  whatever SQLite believes, and so does garbage collection of a connection. This was verified on this
  platform: a raw `open`/`close` dropped the lock, and another process then wrote. Therefore:
  - nothing in the composition opens a held file except through its connection;
  - B3A's raw header read runs only before a file is opened;
  - an exclusive inventory closes every handle before any reopen;
  - every connection is held for the composition's lifetime.
- **The fence.** Before every write transaction, and synchronously,
  `confirmExclusivelyHeld` reads `/proc/locks`. It requires a POSIX `WRITE` lock **owned by this
  process's PID**, over the whole SHARED range, on the device and inode the configured path names
  **now**. It opens no database file. better-sqlite3 transactions are synchronous, so nothing in this
  process can run between the check and the commit. Another process cannot drop this process's lock.
- **Losing authority:**
  - a failed protected-store confirmation marks the composition `executor-lost` for good: it starts
    nothing, believes no outcome, and leaves intents pending;
  - a failed history confirmation (its file replaced at the path, or its lock dropped) fences and
    excludes that namespace only.
- **Closing is a write too (review C1, Critical, fixed).** An exclusive WAL connection
  checkpoints its own view of the WAL into the database, and unlinks the WAL by name, when it closes.
  better-sqlite3 closes every open connection when the process exits. A process that silently lost
  its lock would do this into the files a new holder owns. Before the fix, the independent review
  reproduced:
  - an erased intent;
  - a reused epoch;
  - a false `bootstrap-not-committed`;
  - a double establishment.

  Therefore every exclusive connection closes only through `exclusiveCloser`:
  - it is closed only if the kernel confirms, at that instant, that this process holds its lock;
  - otherwise it is **retained, never closed**, and strongly referenced so garbage collection cannot
    close it either;
  - an `exit` guard kills the process (`SIGKILL`) before native cleanup if any open exclusive
    connection's lock is not held.

  - **Main thread only (re-check R2-H, High, fixed).** A worker thread's teardown (`terminate()`, or
    the process exiting under it) closes and checkpoints its connections without any `exit` guard
    running. So exclusive stores, the lock check and the composition all refuse to run off the main
    thread, and there is a test for this.
  - **Failed opens (R2-L, fixed).** Once the lock is taken, every close goes through the guarded closer,
    including those after a failed open.

  **A Host that lost its authority stops; it never shuts down gracefully.** This is tested with a
  stale process that closes and exits normally while a new holder has committed. The commit, the record
  and the completed intent survive. An operator ceremony for a lost executor is B3C scope.
- **A failed commit is "maybe written" (review M2, fixed).** If the evidence transaction throws a
  database error (an I/O failure at the sync), the handle records that request as possibly committed.
  The intent then stays pending, never completed as "absent". No test injects an fsync fault; this was
  fixed from reading the code.
- **Identity, not names (review L1 and R2-L, fixed).**
  - The protected store may not share a device and inode with any history, and neither may two
    histories, so a bind-mount alias is refused.
  - A duplicated or malformed configuration entry is refused, never merged or dropped.
  - The inventory loads the one configuration snapshot that was path-checked.

**Platform:** Linux only, on the main thread. On macOS and Windows exclusivity cannot be confirmed, so startup is refused
(`PLATFORM_UNSUPPORTED`). WSL2 is Linux, so this runs on Windows-backed development, with data under a
Linux filesystem. These are unsupported:
- network filesystems without coherent POSIX locks;
- filesystems where `stat` and `/proc/locks` report different device numbers (overlayfs in containers,
  btrfs subvolumes). There the fence never confirms, so startup is refused or the executor is lost:
  this fails closed, an availability limit.

Under a PID namespace without its own `/proc`, the PIDs do not match, so it also fails closed.

### Fail-stop, and the dedicated executor process (an activation prerequisite)

The guarded close is a safety invariant and is not weakened here. Its consequences:

- **What triggers the guard.** It fires only at process exit, and only if an exclusive connection is
  still open (never closed while held) and its lock is not confirmed. That happens when the lock was
  silently dropped, or the file at the path was replaced.
  - A normal shutdown with the locks held does not fire it: `close()` closes every connection while
    held, and an unclosed but held connection is closed by the native cleanup, which is safe.
  - Evidence: the B3B suite composes and closes the composition about twenty times in its own process,
    which then exits normally (exit 0).
- **What it does to the process.** It is `SIGKILL` of the **whole process**: no other code in it gets a
  graceful shutdown. Inside a larger Host process, a lost FV lock would turn the Host's eventual exit,
  for every unrelated service, into an abrupt kill. While running, losing the lock stops only FV work
  (`executor-lost`); other services run on.
- **The most likely cause of loss is the Host itself.** Any code in the same process that opens and
  closes a held file, by any means, silently drops the lock:
  - a backup job copying the history files;
  - a log or metrics agent reading them;
  - a second, non-exclusive store handle.

  PROD-02's backup and restore operate on files. In-process, they would do exactly this.
- **Why termination works.** `SIGKILL` runs no user-space code, so no SQLite close, checkpoint or WAL
  unlink can follow. The review's probes, and test 16, show that the new holder's WAL and commits
  survive.
- **The edges:**
  - **Covered:**
    - `SIGTERM` or `SIGINT` without a handler, `SIGKILL` and `abort()` run no cleanup, and so write
      nothing;
    - a normal exit, `process.exit()` and a signal handler that calls `process.exit()` all reach the
      guard;
    - every exclusive close path goes through `exclusiveCloser`, including failed opens;
    - worker threads, macOS and Windows are refused before anything is opened.
  - **Residual:** an earlier `exit` listener that calls `process.exit()` again pre-empts the guard. The
    review observed nothing written in that case, but this has not been proven in general.

**Prerequisite for B3C and any activation.** The FV executor must run as a **dedicated, isolated
process**:
- it runs no other workload;
- it is the only code that opens its files;
- it exits through the guard, or by signal;
- its abrupt termination is an accepted outcome, supervised and restarted by the Host.

B3B does not enforce process isolation, because a flag would only be self-asserted. A composition
inside a general Host process is **not claimed safe**.

## 6. Coordinator ownership (closes F4 and L1)

- `bootstrap({ request, signedStatusText, requesterResponse, approverResponse })` takes **data
  only**. It is read once into a plain copy, so a getter or a function never runs twice and is never
  called.
- The composition itself invokes `coordinateStatusHistoryBootstrap`, inside `boundary.runBootstrap`
  (registry) → `trackBootstrap` (intent). The coordinator gets the admitted handle and the Host's own
  dependencies; no caller ever does.
- The authorizer is built for that one call, over the boundary's gated decision port. No other holder
  of that port exists, which closes L1.
- The coordinator's promise is awaited to its end, so the registration and the intent settle only after
  the durable commit (F7).
- The status source is the trusted composition's choice. Without one, `BOOTSTRAP_DISABLED` is returned
  before anything is registered, recorded or consumed.
- The surface is five methods: `status`, `beginBootstrapDecision` (AUTH-03's challenge only),
  `bootstrap`, `reconcile` and `close`. A test walks every reachable value: no history, store, identity
  store, capability, boundary, registry or inventory is reachable.

## 7. AUTH-03 custody

- The pair is issued inside `composeFvProtectedHost`, and the composition refuses an identity store of
  another organization (`CUSTODY_REFUSED`).
- The boundary is built with `custody: isBootstrapSettlementCapabilityOf`, AUTH-03's own exact
  predicate. No option carries a predicate, a capability or a settlement port (pinned).
- Only the boundary's reconciler holds the settlement port.
- `close()` disposes the boundary and revokes the capability.
- The capability is a module-private, in-process object: it cannot be replayed across processes or
  Hosts.
- The general AUTH-03 lifecycle and AUTH-04A are unchanged, and CORE-05 is not touched.

## 8. Database and WAL protections

`checkProtectedFile` checks metadata only, and never opens the file:
- the configured path is canonical, with no symlinked component;
- the file is regular, not a symlink, with one link, owned by this user, and not writable by group or
  others;
- each `-wal`, `-shm` and `-journal` sidecar is held to the same rules;
- the directory is owned by this user and not writable by group or others.

It runs:
- at startup: a refused protected store refuses startup; a refused history is quarantined and never
  opened;
- again before every fenced history write.

**Residuals:**
- **N6 and ABA.** In an owner-only directory, a substitution needs this user's own write access. The
  kernel check names the inode the path names now, so a replacement while the history is held is
  detected and excludes the namespace. A substitution while the Host is down is caught at start by
  continuity, unless the record is restored with it.
- **WAL by name.** SQLite opens `-wal` by path name. Deleting or replacing it while the Host is down is
  continuity's job: a deleted WAL holding a commit gives `ROLLED_BACK`, as tested. While the executor
  holds the database, no SQLite connection of another process can read or write it, but a raw file
  writer with this user's rights is not stopped by SQLite locks.
- **A WAL deleted while held** is not detected while running (sidecars may be absent). Commits then
  go to an unlinked file and are lost at a crash, and the restart sees `ROLLED_BACK`. This needs
  this user's write access.
- **Not absolute.** None of this is absolute file-identity security. A process running as the same
  user, or root, is inside the trust root. **FV-P4D's independent witness remains required.**

## 9. Startup, shutdown, recovery and quarantine

**Startup:**
1. Read and validate the configuration.
2. Apply the platform and filesystem policy.
3. Open the protected store exclusively and advance the epoch.
4. Open, assess and admit every history exclusively; resolve pending intents only by evidence; quarantine
   the rest.
5. Issue and custody-check the AUTH-03 pair; build the boundary.
6. Build the Kernel-Authority permissions.
7. Expose status.

A refused start releases everything it took.

**Shutdown (`close()`):**
- dispose the boundary;
- revoke the capability;
- close the inventory and its handles;
- close the protected store.

A run still in flight then fails closed: its commit fails, or its post-settle read fails, so its intent
stays pending, and the restart quarantines it. Tested.

**Recovery:**
- an intent is resolved only by evidence with its exact request id and binding;
- nothing is cleared on a timer;
- a restored history is never re-anchored automatically;
- quarantined namespaces wait for B3C's ceremonies.

## 10. Test evidence

`tests/fv-p4c2b3b-protected-host-composition.e2e.test.mjs` has 26 tests. They use:
- real AUTH-03 with software passkeys;
- real SQLite, the real receiver package and the real coordinator;
- real child processes (`tests/fv-p4c2b3b-child.mjs`).

The status source is synthetic. Crash points are hit deterministically, without timing: the child
counts the fence's kernel reads, identifies each write by its call stack, and wraps AUTH-03's
`decision_authorized` appends.

| Matrix | Coverage |
|---|---|
| Persistence 1–13 | <ul><li>intent write refused (CONFLICT) → nothing consumed</li><li>`SIGKILL` before the first consumption, after one, after both, before the commit, right after the commit, before the checkpoint save, before the intent completion</li><li>source refusal</li><li>refused transition</li><li>corrupt record and corrupt intent</li><li>dropped trigger</li><li>missing store</li><li>store-level conflicts, idempotence, fencing and epoch</li></ul> |
| Execution authority 14–20 | <ul><li>a second Host refused at three clocks</li><li>two Hosts racing: exactly one composes</li><li>a stale process with dropped locks after a takeover writes nothing, and its graceful close and exit are stopped by the exit guard; the new holder's commit survives</li><li>lock loss mid-run: the commit is fenced, the intent stays pending</li><li>a holder killed, then recovery with a higher epoch</li><li>a history held by a foreign process is `UNAVAILABLE`</li><li>a replayed request from another instance</li><li>shutdown during a run</li></ul> |
| Coordinator and custody 21–30 | <ul><li>five-method surface and a reachability walk</li><li>function and getter inputs</li><li>disabled without a source</li><li>wrong binding and wrong namespace</li><li>the same human twice</li><li>an unpermitted approver</li><li>swapped roles</li><li>capability revoked at close</li><li>a foreign organization's identity store</li></ul>CORE-05 and bootstrap domain separation is AUTH-03's own and is covered by its suites |
| History continuity 31–40 | <ul><li>a history replaced while held</li><li>an older backup restored</li><li>the WAL of a crashed Host deleted</li><li>a symlinked file or directory</li><li>a file writable by others</li><li>missing and corrupt histories</li><li>unexplained evidence</li><li>**the history and the protected store restored together: undetectable (limitation, FV-P4D)**</li><li>one namespace quarantined alongside a healthy one</li></ul> |
| Isolation 41–47 | <ul><li>no caller in `src/` or `scripts/`</li><li>not exported from the FV index</li><li>new-module import allowlists (no source, document use, Fileverse, route or network)</li><li>the composition passes AUTH-03's predicate and accepts none</li><li>every database under the OS temporary directory</li></ul> |

## 11. Review

- **Implementing-agent self-review**, with verification probes: the lock semantics, the `/proc/locks`
  format, the POSIX close hazard and garbage collection.
- **A separate AI review agent** (same model family, read-only, given the code and the objectives but
  not the author's conclusions, with runnable probes):
  - **C1 Critical (confirmed by probe):** the closing checkpoint of a stale connection. Fixed (§5).
    The test that had stepped around it (the stale process was SIGKILLed) now closes and exits it
    gracefully.
  - **M2 Medium (by reading):** a thrown commit could be read as absent. Fixed (§5).
  - **L1 Low:** a store alias by name only, and a second configuration read. Fixed.
  - **L2 Low:** overlayfs and btrfs device mismatches. Documented, fails closed.
  - **Re-check of the fixes (same agent):**
    - its C1 probes now preserve the new holder's commit, with no epoch reuse;
    - endings tested: a natural exit, `process.exit`, and a SIGTERM handler. Each is stopped by the guard;
    - **R2-H High (confirmed by probe):** worker threads bypassed the guard. Fixed: main thread only;
    - **R2-L Low:** raw closes after a failed open, history-to-history aliases, and duplicate configuration
      entries. All fixed.
    - No new false-settlement path.
  - **Info:**
    - PID namespaces fail closed;
    - a WAL deleted while held (documented);
    - AUTH-03 is not exclusive: another service over the same store can only burn a decision, never
      settle one falsely;
    - the trusted receiver could keep its per-call writable store (it is trusted Host code).
- **Final residual review (implementing agent, targeted tests and mutants):**
  - **I2 (the lock check before completing an intent):**
    - *Test.* The lock is dropped inside the fence of `save` or `completeIntent`, after that check has
      passed. Nothing is completed, and the restart settles only by evidence.
    - *Mutants.* I2 removed alone survives these tests. Combined with the protected store's write fence
      disabled, it is killed.
    - *The invariant:*
      - every intent transition is a fenced protected-store write;
      - only this process's coordinator, through the tracked handle, commits evidence for its request
        ids (F4 is closed);
      - a second executor cannot exist while the protected lock is held.

      So the fence alone prevents completion after lock loss, completion of another executor's intent,
      a false negative, and clearing without evidence.
    - *Verdict.* The check is redundant with the fence; it is kept as defence in depth.
  - **I3 (the lock check in the reconciler's snapshot):**
    - `reconcile()`'s start-only authority check did **not** cover the interval up to its settlement
      writes, which go to AUTH-03 and are not fenced by FV locks.
    - Fixed: the per-settlement `settlementGuard`.
    - *Test.* The lock is dropped right after the start check. No settlement is written, and a later
      executor settles the truth.
    - *Mutants.* Either layer alone (the snapshot check or the guard) survives. Both removed are killed.
    - *Residual.* The guard and AUTH-03's append are not one atomic step: AUTH-03 writes asynchronously
      to its own store. A loss in that gap could let one settlement through. It is still a truthful
      settlement: evidence for a consumed decision can only come from the run that consumed it, in this
      process, and AUTH-03 refuses a second, different settlement.
- **Publication (Linux, B3B-REL): simultaneous start.** Test 14 failed 10 times in 15 on a clean Linux
  copy: each of two Hosts kept SQLite's SHARED lock from its first read (exclusive locking mode retains
  it), so both refused (`EXECUTOR_HELD`). This failed closed, but it was a liveness defect. Fixed: a refused
  acquisition, which never held the lock and whose connection is already closed, is retried up to six times
  after a short random pause. Initialization is never retried, and a store another live Host holds is still
  refused. After the fix: 0 failures in 20.
- **No human review yet.**

## 12. Remaining dependencies (operational blockers)

- **Dedicated executor process (§5):** a prerequisite for B3C and any activation.
- **B3C:**
  - PROD-02 registration of the protected store, and its backup and restore;
  - restore promotion;
  - operator ceremonies for quarantined intents, lost executors and initial registration;
  - wiring AUTH-04A and this composition onto one identity service lifecycle.
- **B6:** a trusted issuer-currentness source. Until then bootstrap execution cannot be enabled in the
  Host.
- **FV-P4D:** an independent continuity witness. A whole-state restore, or a same-user or root file
  writer, is undetectable without it.
- **FV-P5:** document-use enforcement.

**Operational activation: NO-GO.**
