# FV-P4C-2B3A — Host composition foundations

> **NON-OPERATIONAL.** This increment adds internal primitives only. Nothing composes them: the
> composition root, the Host, routes, CLIs and scripts do not name them (pinned by
> `fv-p4c2b3a-host-composition-foundations.test.ts` and `fv-p4c2b2-structure.test.ts`). There is no
> bootstrap invocation, issuer source (B6), witness (FV-P4D), endpoint or governed execution.
> Operational bootstrap is **NO-GO**.

## 1. Actual contracts (as found on `main` at `f182f309`)

| Area | What exists | Consequence for FV |
|---|---|---|
| AUTH-04A composition (`composition/human-authority-composition.ts`) | `composeHumanAuthority` opens the identity store and builds the service with `createHumanIdentityService` (no settlement capability). It returns `{ store, port, … }`. The root keeps `store` internal; `AocEnterprise` exposes only `humanAuthority` (`HumanAuthorityPort`, which includes `identity: HumanIdentityService`). | Issuing the FV settlement capability means building the service with `createHumanIdentityServiceWithBootstrapSettlement` **in that one place**. That is a composition-root change (B3B), not made here. |
| AUTH-03 capability (`human-identity/service.ts`) | Module-branded, instance-bound, revocable, the bound settlement port; the service is frozen. | Used as is. |
| CORE-05 channel (`approval-authority/human-decision.ts`) | Reconciles CORE-05 decisions only. | Unchanged. |
| Kernel-Authority grants | `createKernelAuthorityBootstrapPermissions` (2B2B). | Unchanged; composed in B3B. |
| FV coordinator | Steps: request → status → **authority (consumes both decisions)** → source → atomic SQLite commit. | In-flight registration must wrap the whole call (§5). |
| FV reconciler (2B2C) | Cursor paging; inventory snapshots; namespace-bound v2 decisions; in-process namespace→file pin. | Fed by the foundations below. |
| FV SQLite history | Pinned to one namespace; no store id, not CORE-07 anchored, **not in PROD-02** (`STORE_DEFINITIONS`), so not backed up. | Continuity needs a Host-held record (§4). Backup and restore integration is B3C. |
| PROD-02 (`scripts/portability/store-registry.mjs`) | One authoritative store registry. Backup uses the Online Backup API with a manifest. Restore: stage, verify, deep-verify, promote with an in-progress marker and a safety copy. No per-store identity outside the files; there is no installation record. | An FV store definition and its restore hook come in B3C. |
| CORE-07 witness | Records `store_id` per slot for **signed** stores only. | Not applicable to the unsigned FV history; FV-P4D is its independent continuity evidence. |
| Host configuration | Environment variables plus a governed-actions file (`version: 1`). No configuration generation, no process lock. | The generation and an exclusive-executor lease are B3B prerequisites. |

## 2. Threat model (what B3A defends, and where)

| Threat | Defence | Where |
|---|---|---|
| A bootstrap subsystem or controller obtains the settlement capability or the raw store | The boundary captures the capability and exposes only bound `peek` and `authorize`; it never takes a store | `authority-boundary.ts` |
| A look-alike or foreign capability | Exact custody: AUTH-03's `isBootstrapSettlementCapabilityOf(capability, service)`, by the module-private instance, refuses a look-alike, another store's or another service instance's capability, even when nothing is listed | boundary + AUTH-03 |
| A revoked capability | Refused at construction; revoked later, AUTH-03 refuses each write (`SETTLEMENT_UNAUTHORIZED`), reported unresolved | AUTH-03 |
| A commit, then a crash before the record is re-captured, then the file replaced or rolled back (review H1) | A durable write-ahead intent before every own bootstrap; a pending intent without evidence quarantines the namespace (`INTENT_UNRESOLVED`) | `host-inventory.ts` |
| Evidence added outside this Host's bootstrap path: a forged row or another writer (review M1) | New evidence is admitted only for a pending intent of this Host with the same request id **and** binding (`UNEXPLAINED_EVIDENCE`; re-review N2). A writer of the file who forges evidence for exactly a pending intent's request and binding is still believed: the file's writers are a trust root until FV-P4D | `history-continuity.ts` |
| A decision consumed outside `runBootstrap` (re-review N1) | The exposed `authorize` refuses unless a registered run of exactly that decision's signed binding is running, and records that run's intent first | `authority-boundary.ts` |
| An unauthenticated request quarantining a namespace (re-review N4) | The intent is written only by the gated `authorize`, immediately before consumption. A run that settles without evidence completes its intent at once | boundary + inventory |
| `refresh()` closing a handle under a running bootstrap (re-review N3) | `refresh()` is a no-op while a tracked bootstrap runs | `host-inventory.ts` |
| A file swapped while it is being opened (re-review N6) | Identity sampled before the open and after validation; a difference refuses the open | store |
| Two forks at one revision (review M2) | Per-row digest of the whole validated entry (`DIVERGED`) | store checkpoint |
| A file swapped at the path under an open handle (review M3) | Device and inode compared on every assessment (`FILE_REPLACED`) | store checkpoint |
| A registered binding that differs from the one consumed (review M5) | The operation receives the frozen parsed request that was registered | `operation-registry.ts` |
| Namespace remapped to another file after a restart | The continuity record pins the resolved path: `MOVED`, quarantined | `history-continuity.ts` |
| A file replaced at the same path (fresh or another history) | Content comparison against the record: `ROLLED_BACK` (empty or subset) or `DIVERGED` | `history-continuity.ts` |
| An older backup restored | `ROLLED_BACK`, quarantined, never automatically cleared | `history-continuity.ts` |
| Corrupt, missing or foreign-namespace files | `CORRUPT`, `MISSING` (never recreated), `NAMESPACE_MISMATCH` | `history-continuity.ts` |
| A negative settlement while the bootstrap still runs (F3) | Registered before consumption, released only when the operation settles | `operation-registry.ts` |
| Duplicate concurrent bootstraps of one binding or request | Refused before starting (`DUPLICATE`) | `operation-registry.ts` |
| A broken history blocking others | Per-namespace admission; quarantined namespaces only leave their own decisions unresolved | `host-inventory.ts` + reconciler |
| A caller-asserted completeness or a stale configuration | No completeness input. The configuration generation never decreases, and the snapshot generation is internal and monotonic | `host-inventory.ts` |

## 3. Authority custody (`createFvBootstrapAuthorityBoundary`)

| Holder | Receives | Never receives |
|---|---|---|
| Authorizers (the bootstrap path) | `bootstrapDecisions`: bound `peekBootstrapAuthorityDecision`, and an `authorizeBootstrapAuthorityDecision` gated to registered runs of the decision's own binding, on a single plain copy of the response (R3 F1) | the service, the store, the capability |
| The bootstrap runner | `runBootstrap(request, (parsed, history) => coordinator)`: in flight, then the durable intent, on the admitted handle | the registry, the inventory |
| Reconciliation | nothing: `reconcile()` runs inside | — |

- The boundary takes the AUTH-03 pair `{ service, settlementCapability }` and the Host inventory provider.
- **Exact custody at construction.** `custody(capability, service)` must hold. That is AUTH-03's
  `isBootstrapSettlementCapabilityOf`, the one AUTH-03 addition here: a predicate over the
  module-private instance map, granting nothing.
  - The predicate is passed in, because this module may not import AUTH-03. The check is only as good
    as what the composition passes (re-review N5).
  - A structure test (R3) already requires any non-test caller to pass AUTH-03's function, imported
    from the identity module; there is none today (§10).
  - Every run also reconciles only decisions the service knows.
- There is no getter for the capability or the store, and no method accepts either from a caller.
- `dispose()` refuses every later call and closes the registry. Revoking the capability
  (`revokeBootstrapSettlementCapability`) is the composition's job (B3B), because the module may not
  import AUTH-03.
- There is no test mode.

## 4. Durable namespace identity (`history-continuity.ts`)

A **continuity record** is captured from a genuine handle through the store's own validators
(module-internal `storeCheckpointOf`, not exported from the index). It holds:
- the namespace;
- the resolved configured path;
- the schema;
- the inventory generation;
- the monotonic row counter;
- every key's revision;
- the digest of every permanent evidence record;
- a self-digest.

| Situation | Class | Admitted |
|---|---|---|
| 1. Same genuine store reopened | `CONTINUOUS`, or `ADVANCED` after freshness-gate updates or own pending commits | yes |
| 2. File moved, identity unchanged | `MOVED` | no: explicit re-registration only (B3C) |
| 3. File replaced | `ROLLED_BACK` (fresh or subset) / `DIVERGED` (another history, or a fork at one revision) / `FILE_REPLACED` (swapped under an open handle) / `UNEXPLAINED_EVIDENCE` | no |
| 4. Older backup restored | `ROLLED_BACK` | no |
| 5. Corrupt store | `CORRUPT` | no |
| 6. Missing file | `MISSING`; never recreated | no |
| 7. Unknown namespace | `UNREGISTERED` | no |
| 8. Conflicting namespace registration | `configuration-invalid` (whole inventory) / `NAMESPACE_MISMATCH` | no |
| 9. Conflicting database identity | `configuration-invalid` (one file twice) / `NOT_GENUINE` | no |
| 10. Incomplete startup configuration | `not-loaded` / `configuration-invalid` | no snapshot |

**Not rollback prevention.**
- An empty record has nothing to compare (`proof: 'none'`). That is harmless only because every own
  commit is covered by a pending intent until the record is re-captured.
- Commits that bypass `trackBootstrap` are `UNEXPLAINED_EVIDENCE`, and are never silently accepted.
- The record is Host data. Its self-digest detects accidental damage only, and a forged record is
  believed (tested as a limitation). It must live in protected storage (B3B).
- A record and a history restored together, equally old, are undetected. That is FV-P4D's
  independent continuity evidence.
- **File identity** (device and inode) is per handle, never part of the record: it is sampled from
  the path before the open and after validation, because better-sqlite3 exposes no descriptor, and
  compared with the path again on every checkpoint (`FILE_REPLACED`). A platform reporting inode 0
  fails closed (`FILE_REPLACED` on every read), which is a liveness cost on some network filesystems.
  - **Tested deterministically (R3):** a file substituted between the pre-open sample and the
    connection is refused at open. The test wraps the real `fs.statSync` (no production seam) and
    substitutes at the store's exact first sample.
  - **Residual (ABA), tested as a limitation:** substituted after the first sample and put back before
    the second, the open is accepted. An older or different substitute is still caught by the content
    comparison on that very handle (`ROLLED_BACK`/`DIVERGED`/`UNEXPLAINED_EVIDENCE`). An identical one is
    admitted, and because SQLite opens the `-wal`/`-shm` sidecars **by path name**, its writes reach
    the configured path's WAL. Sidecars are outside the main file's identity.
  - Exploiting either needs write access to the history directory, which is already the file-writer
    trust root (§10). It does not block these foundations; B3B must keep that directory writable only
    by the Host's FV executor.
- **Reopen window (R3 F8):** assessment closes its read-only probe and reopens read-write. A file
  substituted in between is opened read-write, and WAL setup may write to it before the namespace
  and content checks refuse it. Again a directory-writer capability.
- **The row digest is versioned** (`frontera:sovereign-status-history-row:v1`). A future entry shape
  needs a new record version, or every record would read `DIVERGED`.
- **Read-only assessment** can be refused with a hot `-wal` and no writable `-shm`. That gives
  `UNAVAILABLE`, a liveness cost only (re-review N7).
- **Restore candidates with any new evidence** are `UNEXPLAINED_EVIDENCE`, even when an intent would
  explain it. This is conservative (re-review N9).
- Nothing asserts global currentness.

## 5. In-flight lifecycle (F3, `createBootstrapOperationRegistry`)

1. `run(request, operation)` derives the binding with the coordinator's own functions. It registers
   `(namespace, binding)` and the request id **before** `operation` starts, so before any decision is
   consumed. A duplicate or invalid request is refused before anything starts.
2. The registration lasts until the operation's own promise settles. There is no timer. A caller's
   timeout or cancellation does not release it, and an operation that never settles stays in flight
   (`inFlightOperations()`, with its start time).
3. The reconciler's `inFlight(commitment)` resolves the decision's **signed** namespace and binding
   (AUTH-03 lookup). Unknown or unreadable means in flight, never a negative.

**Why the in-flight registry is in memory, and the durable intent beside it.** A bootstrap's only
durable effect is one atomic SQLite transaction, and an operation cannot outlive its process. So
"still running" needs no durability. That holds **only if one process at a time executes bootstraps
for a set of histories**. No Host process lock exists today, so an exclusive-executor lease is a
**B3B precondition**, and nothing here claims it.

What does need durability is whether the record has caught up with a commit (review H1). Without a
durable intent, a crash between a commit and the re-capture, followed by a replacement or rollback of
the file, would look like an empty, continuous history. `trackBootstrap` therefore:
1. writes the intent `{ requestId, bindingDigest }` through `ensureIntent()`. The boundary's gated
   `authorize` calls it immediately **before** the first consumption. If the write fails, nothing is
   consumed, and a run that never reaches consumption writes nothing.
2. once the operation settles in process, the commit either happened or it never will:
   - **no evidence for its request id:** the intent is completed (one write);
   - **evidence:** the record is re-captured first, then the intent is completed;
3. on any failure, leaves the intent pending.

**Refresh and bootstraps exclude each other (R3 F2).** `refresh()` is a no-op while a tracked
bootstrap runs, including its post-settle check and re-capture. `trackBootstrap` is refused
(`INVENTORY_REFRESHING`) while a refresh is in progress, before anything is consumed, because the
refresh closes the handles it replaces. A refresh overtaken by `close()` keeps nothing and does not
reopen the inventory.

**The gate reads the response once (R3 F1).** The boundary's `authorize` copies the caller's
response into plain frozen JSON once, then peeks and consumes that same copy, and checks the consumed
decision's target again. A getter or proxy can no longer show the gate one decision and AUTH-03
another.

**The operation's promise must cover the commit (R3 F7).** The registration and the intent settle
when `operation` settles. An operation that fires the coordinator and returns, or races it against its
own timeout, releases its registration and completes its intent while the commit can still land: a
false not-committed. B3B's coordinator call must be awaited to completion inside `runBootstrap`; this
is a contract, not enforced.

**The gate is checked at call time (release review L1).** `authorize` checks the registration and
writes the intent synchronously, then awaits AUTH-03's consumption. A second holder of
`bootstrapDecisions` that calls it during a run can see its consumption finish after that run has
settled. The result is a decision consumed with no evidence, settled not committed, which is true
because no run of that binding is left to commit it. B3B should hand `bootstrapDecisions` only to the
run's own authorizer, or have the run await outstanding gated calls before it settles.

**Durable-write ordering B3B storage must provide (R3 F5).** The port here is in memory in tests; these
are requirements, not properties of anything in B3A:
1. `beginIntent` is durable (synced) before it returns. It is what blocks a false negative after a
   commit followed by a crash and a rollback (H1); a lost intent reopens H1.
2. `save(record)` is durable before `completeIntent` is called, and the two are never reordered.
3. A write that throws counts as "maybe written": a later read must tolerate either state.
4. Intents and records are read back after restart before any reconciliation (startup order, §8).
The history commit and these writes are in **different stores, with no cross-store transaction**: every
crash point between them is covered by the table below, not by atomicity.

| Crash point | After restart |
|---|---|
| after one or both decisions consumed, before the commit | intent pending, no evidence: indistinguishable from commit-then-rollback, so the namespace is **quarantined** (`INTENT_UNRESOLVED`). Its decisions stay unresolved until an authorized operator ceremony (B3C); never cleared automatically |
| intent written, nothing consumed; or during the source check | intent pending, no evidence: **quarantined** (`INTENT_UNRESOLVED`); no decision settled |
| during the SQLite commit | one transaction: either no evidence (row above) or evidence (row below) |
| after the commit, before the re-capture | the evidence resolves the intent: record re-captured, intent completed, settled committed |
| after the re-capture, before the intent is completed | the evidence (already in the record) resolves it at restart (R3 F3; before R3 this stayed quarantined) |
| after the commit, then the file replaced or rolled back | intent pending, no evidence: **quarantined**, never a negative (H1) |
| no crash: a commit made **through the tracked handle**, rolled back **in place** (same inode) before the run settles | the handle remembers the request ids it committed itself; evidence it committed that is now gone keeps the intent **pending**, so the namespace is quarantined (release review M1; before, the intent was completed and a false negative followed). In memory per handle: a rollback by another process after the handle closes is the crash rows above. An operation that commits through **another** handle it opened itself is not covered; that breaks the operation contract (F4, B3B) |
| history, record **and** intent journal restored together | indistinguishable from no commit: settled `bootstrap-not-committed`. **Undetectable here; FV-P4D** (tested as a limitation) |

Every row is exercised by the B3A tests through the real boundary, AUTH-03 and SQLite, with a crash
modelled as a run that never settles followed by a fresh inventory and boundary over the same state.
A kill of the process mid-commit is the FV-P4C-2A SQLite crash test's subject, not re-tested here.

## 6. Trusted inventory (`createHostHistoryInventory`)

- **Inputs:** the Host's protected configuration provider (`{ generation, histories }`), a continuity
  record and intent port (`load`, `save`, `pendingIntents`, `beginIntent`, `completeIntent`; protected
  storage is B3B) and the clock.
- **Configuration generation:** never lower, and never reused for another set (review L2).
- **Opening:** histories are assessed on read-only handles, so a quarantined file is never written to
  (review M6). Only admitted histories are reopened read-write and re-assessed.
- **Explicit readiness:** `not-loaded`, `configuration-invalid`, `ready`, `degraded`, `unavailable`,
  `closed`.
- **Opening:** `refresh()` opens every configured history itself (never `create`), and keeps only
  admitted ones. A quarantined namespace is closed and left untouched.
- **Snapshots:** `inventory()` re-assesses every admitted history on each call, file identity
  included, and leaves out any namespace with a pending intent. So the reconciler's re-read before a
  negative is a real revalidation. The snapshot generation is internal and increases whenever the
  admitted set changes. Paths are resolved, as the reconciler resolves them (review L1).
- **Per-namespace containment:** a quarantined namespace's decisions stay `HISTORY_NOT_IN_INVENTORY`;
  others proceed.
- **`historyFor(namespace)`** hands the admitted **writable** handle to the receiver's freshness gate.
  That handle can also write bootstrap evidence (the store checks no human authority). Evidence written
  outside a tracked run is `UNEXPLAINED_EVIDENCE` and quarantines the namespace, but it stays in the
  history (R3 F4). B3B must hand the gate a narrowed port without the evidence write.
- **No public registration API:** first registration (`captureHistoryContinuity` on a newly created
  history) is an operator ceremony for B3B/B3C.

## 7. Backup and restore quarantine (`assessRestoreCandidate`)

- A staged candidate is opened read-only, never created, always closed, and compared with the Host's
  record for its namespace.
- `promotable` only when it holds everything recorded (`CONTINUOUS`/`ADVANCED`); `automatic` is always
  `false`.
  - An older backup is `ROLLED_BACK`.
  - Another history is `DIVERGED`.
  - A wrong namespace, corrupt or missing file, or a missing or altered record is never promotable.
- Restoring an older copy over the configured path is quarantined by the inventory on every refresh,
  until the right file is back.
- Conflict latches and withdrawals are never cleared: a rollback of any key lowers its revision,
  which is `ROLLED_BACK`.
- **No real restoration exists.** The FV store has no PROD-02 definition yet. The stage, verify,
  authorize and promote integration, with the old files preserved, is **B3C**. Detecting a rollback of
  record and file together is **FV-P4D**.

## 8. Startup order (for B3B)

1. Load protected Host configuration, with a generation ≥ the last loaded.
2. Validate the store registry (PROD-02 definition for FV histories; B3C).
3. Load continuity records from protected storage.
4. `refresh()`: open, verify and assess every history; quarantine the rest; readiness is explicit.
5. Acquire the exclusive-executor lease. The in-flight registry starts empty; pending intents were
   resolved by evidence in step 4, or quarantine their namespaces (§5).
6. Load reconciler progress (optional `progress` port).
7. Construct the AUTH-03 pair in the AUTH-04A composition, then the FV boundary.
8. Make reconciliation eligible only when readiness is `ready` or `degraded`.
9. Keep operational bootstrap disabled (B6 and FV-P4D outstanding).

A crash at any step leaves nothing written by these foundations, except the records that
`recordProgress` writes after an own commit. Nothing is ever created, reset or re-anchored.

## 9. Increments

| Increment | Scope |
|---|---|
| **B3A** | The primitives above, unreachable, with tests |
| **B3B (done, `FV_PROTECTED_HOST_COMPOSITION.md`)** | An internal FV composition root, unreachable: <ul><li>the AUTH-03 pair issued inside it (not in AUTH-04A, which is unchanged), the boundary, and capability revocation at close</li><li>the protected, durable record and intent store</li><li>the exclusive executor (kernel file locks, fenced on every write)</li><li>coordinator ownership (F4, L1)</li><li>the filesystem policy</li><li>bootstrap execution disabled without a status source</li></ul> |
| **B3C** | <ul><li>A PROD-02 store definition for FV histories and the protected store, and backup coverage</li><li>A restore hook calling `assessRestoreCandidate`, with operator-authorized promotion keeping the old files</li><li>Operator ceremonies for `MOVED` re-registration, for resolving an `INTENT_UNRESOLVED` namespace and for a lost executor</li><li>Wiring AUTH-04A and the B3B composition onto one identity lifecycle</li></ul> |
| **B6** | A trusted status-currentness source |
| **FV-P4D** | An independent witness of history continuity |

## 10. Trust boundaries (R3)

**Forged evidence (N2).** What it takes to have evidence accepted for a pending intent:

| Actor | Can it be accepted? |
|---|---|
| An untrusted caller (no port, no handle) | No: nothing reachable takes evidence, a handle or a capability |
| A caller holding `bootstrapDecisions` | No evidence; and since R3 F1, no decision outside its registered binding |
| The `runBootstrap` operation (Host code, writable handle) | Yes, for its own intent: it may skip source verification and commit evidence naming the consumed decisions, then settled committed (R3 F4). B3B: the boundary must invoke the coordinator itself and never expose the handle |
| A holder of `historyFor`'s handle | Evidence outside a run: quarantined as `UNEXPLAINED_EVIDENCE` |
| A compromised Host process | Yes: it holds the capability, the handles and the record port |
| A writer of the history file or directory | Yes, for any pending intent (request id and binding are not secret); including the ABA and WAL paths in §4 |
| A database rollback alone | Caught while a record or intent is newer (`ROLLED_BACK`, `INTENT_UNRESOLVED`), and during a run for commits made through the tracked handle, by that handle's memory of them (release review M1; an operation committing through another handle is F4); not when restored together with them (FV-P4D) |

B3A provides **no cryptographically independent evidence authenticity**. B3B capability custody can
narrow the in-process rows (no exposed handle, a narrowed gate port, protected storage, filesystem
permissions). The file-writer, compromised-process and whole-restore rows need FV-P4D's independent
witness.

**Custody predicate (N5).** The boundary cannot import AUTH-03, so `custody` is passed in. AUTH-03's
`isBootstrapSettlementCapabilityOf` is exact (module-private `SETTLEMENT_CAPABILITIES` and
`SERVICE_INSTANCES` WeakMaps, live, unrevoked). A fake `() => true` would let the boundary reconcile
through a look-alike or foreign port: settlements silently not recorded in this service, or invented
results. It cannot forge AUTH-03 records, because AUTH-03 checks the capability on every write. A
structure test now requires any future non-test caller of `createFvBootstrapAuthorityBoundary` to
pass `custody: isBootstrapSettlementCapabilityOf` imported from the identity module. Today there is
no caller, and nothing composes these modules. A stronger B3B option is an AUTH-03-minted port, with
no predicate at all.

## 11. Review

- **Self-review** by the implementing agent.
- **A separate review agent** (same model family, read-only, given the code but not the author's
  conclusions). It found one High (H1) and six Medium (M1–M6). All are addressed above and tested.
  Lows:
  - **L1, L2, L4:** fixed.
  - **L3:** the error-message mapping fails closed.
  - **L5:** symlink and hardlink aliases are caught by the store's namespace pin.
  - **L6:** the structure scan now also covers `scripts/`.
  - **L7:** documented.
- **Second pass** (the same agent, on the fixes). It found one High (N1) and five Medium (N2–N6),
  all addressed above and tested where testable:
  - **N2:** narrowed to a documented file-writer trust root.
  - **N5:** a B3B structure requirement.
  - **N6:** the bracketing is not race-tested.
  - Lows N7–N9 are documented.
- **Third pass (R3)**, a fresh read-only agent of the same model family, which had not reviewed this
  code, given the diff and the security objectives but not the earlier findings or conclusions, with
  runnable probes:
  - **F1 High (confirmed by probe):** the gate peeked and consumed two reads of a caller's object, so
    a switching getter consumed another binding's decision outside its run (an N1 bypass). Fixed: one
    plain snapshot, and the consumed target re-checked. Tested with a getter and a proxy.
  - **F2 Medium (confirmed):** a bootstrap started while `refresh()` awaited ran on a handle the
    refresh then closed (fail-closed DoS). Fixed: mutual exclusion, and the count dropped only after
    post-settle work. Tested in both orders.
  - **F3 Medium (confirmed):** a crash after the re-capture left the namespace quarantined forever.
    Fixed: intents resolve by the file's exact evidence, recorded or new. Tested.
  - **F4 Medium:** the run's operation and `historyFor` hold a handle that can write evidence. Open,
    for B3B (§6, §10).
  - **F5 Medium:** write ordering unstated. Documented (§5).
  - **F6 Low:** caller-supplied custody. Pinned (§10).
  - **F7 Low:** the operation's promise must cover the commit. Documented (§5).
  - **F8 Low:** the reopen window. Documented (§4).
  - **F9, F10:** informational (§4, §10).
  - **N6:** now tested deterministically, with the ABA residual characterized.
- **Release review** (PR #247), a fresh read-only agent of the same model family, given the published
  diff and the security objectives, with runnable probes:
  - **M1 Medium (confirmed by probe):** a commit rolled back in place (same inode, for example through
    SQLite's backup API) under the open handle before the run settled let the post-settle "no
    evidence" branch complete the intent. The namespace was then admitted, and the reconciler could
    settle a committed bootstrap as not committed. Fixed: the handle remembers what it committed, and
    evidence that disappeared keeps the intent pending. Tested, and three mutants are killed.
  - **Re-check of the fix (same agent):** its probe now leaves the intent pending and the namespace
    out of the snapshot. **N-L1 Low:** an operation that commits through a handle it opened itself,
    and not the one it was handed, is not covered. That is a contract violation by trusted Host code,
    the F4 class: B3B's boundary invokes the coordinator on the tracked handle itself. **N-L2 Low:**
    the wording here is narrowed to match. An I/O error that leaves a "failed" commit durable,
    combined with an in-place rollback before settle, is informational.
  - **L1 Low:** the gate is checked at call time, not held through consumption. Documented (§5).
  - **L2 Low:** CHANGELOG wording on when the intent is written. Fixed.
  - **L3 Low:** an unused `INTENT_NOT_RECORDED` refusal literal. Removed: a failed intent write
    throws from `ensureIntent` and refuses the consumption.
  - **I1–I4:** informational. A refresh can close handles an in-progress `reconcile()` reads; that
    fails closed as unavailable, never as a negative. `refresh()` is silently a no-op while excluded.
    The internal export surface was reviewed. A declaration-order note on `SERVICE_INSTANCES`.
- **No human review yet.**
