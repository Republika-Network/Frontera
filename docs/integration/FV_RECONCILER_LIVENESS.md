# FV-P4C-2B2C — Reconciler liveness and history inventory integrity

> **NON-OPERATIONAL.** Nothing here is composed into a Host (B3), and there is no trusted status
> source (B6), external witness (FV-P4D), endpoint, CLI or governed execution. The reconciler
> remains an isolated component exercised only by tests.

This increment resolves two findings recorded in `FV_AUTHORITY_LIFECYCLE.md` §7a after
FV-P4C-2B2B (#245): **F2**, reconciler starvation, and **R5**, an unverified history inventory.

## 1. Baseline (as found on `main` after #245)

- `createBootstrapAuthorityReconciler` processed `unsettledBootstrapAuthorityDecisions().slice(0, maxDecisions)`
  on every run. AUTH-03 lists decisions in chain-projection order (oldest first), so a run always
  began at the same place.
- The reconciler searched a fixed `histories` array for evidence. If no evidence was found after the
  grace bound, it recorded `bootstrap-not-committed` / `NO_BOOTSTRAP_EVIDENCE`.
- The AUTH-03 bootstrap decision (format v1) signed `approvalRequestId = frontera.sovereign-status-bootstrap:<bindingDigest>`.
  It named the binding digest, but **not** the namespace whose history the bootstrap targets.

Neither finding had been changed by #245.

## 2. F2 — liveness

### Root cause

A decision that stays unresolved (in flight, within grace, history unavailable) or in conflict is
never settled, so it stays in the unsettled list. With a fixed "first `maxDecisions`" window, at
least `maxDecisions` such decisions ahead of a valid one hide it on every run, forever. This was
reproduced: two stuck decisions with `maxDecisions = 2` blocked a third valid one.

### Alternatives considered

| | Design | Verdict |
|---|---|---|
| A | Durable cursor over a stable ordering | Chosen, with the durability left to the Host (an optional port), so no schema |
| B | Pagination over the unsettled set | The same as A once the page key is stable; plain offsets break when settled records leave |
| C | Skip-and-report with durable conflict tracking | Needs a new table or AUTH-03 row kind to remember "known stuck"; more state to trust and to corrupt |
| D | Bound only writes, examine everything | Does not bound reads; still starves under enough stuck decisions |

### Algorithm

1. List every unsettled decision. AUTH-03 already holds them in memory, so the listing itself is not
   bounded here.
2. Group the listed records by commitment. A record whose commitment is not `sha256:<64 hex>` falls
   into one malformed group with key `''`.
3. Sort the keys lexicographically. A commitment is a SHA-256 over a contract that includes a
   server-generated nonce, so no requester can choose where its decision sorts.
4. **The page** is up to `maxDecisions` keys, starting at the first key greater than the cursor and
   wrapping around. A run never examines a key twice.
   - With no cursor yet (the first run of a reconciler, and no valid durable cursor), the page
     starts at a uniformly random index (`crypto.randomInt`).
5. **The cursor** becomes the page's last key, *before* the page is processed. It is then handed to
   `progress.save` when a Host provides one; a failing save is tolerated.
6. Each key is examined:
   - malformed group → conflict `DECISION_MALFORMED`;
   - several records for one commitment → conflict `DECISION_DUPLICATE` (the listing is not
     believed for it);
   - otherwise the B1 settlement rules, with R5's inventory rules (§3).

### Guarantees

- **No starvation within a process.** The cursor moves past every examined decision whatever its
  result. A decision that stays unsettled is examined again within `⌈(N + A) / maxDecisions⌉` runs,
  where `N` is the number of unsettled decisions when the revolution starts and `A` the number that
  arrive during it. Under finite load (fewer than `maxDecisions` arrivals per run), every decision is
  examined in every revolution.
- **Restart.** Without durable progress, each new reconciler starts at a uniformly random index, so
  every decision has at least a `maxDecisions / N` chance of being in the first page. A restarted
  process never deterministically returns to the same blocked prefix. With `progress`, a restart
  continues exactly where the last run stopped (tested over 16 restarts: one full revolution).
- **Fault containment (review #4).** A record that throws while it is read, including while its
  commitment is read for grouping, is `DECISION_MALFORMED`. An unexpected fault while settling one
  decision is reported `SETTLEMENT_FAILED`; if such a fault came after the settlement was written,
  the report understates what happened, never the reverse. Either way the rest of the page still
  runs. Throwing records can only come from a look-alike port; genuine AUTH-03 records are plain
  data. The cursor is also saved before processing, so even a process crash mid-page
  cannot pin it (the rest of that page then waits one revolution).
- **A bounded progress port (review #5).** `load` is awaited at most 5 s, once per reconciler; `save`
  at most 5 s, once per run. A port that never answers delays every run by up to 5 s and never stalls
  reconciliation. A timed-out `save` is not cancelled, so a late old cursor can land after a newer
  one. The durable cursor then moves backwards, which costs re-examination, never an outcome. A port that always returns the
  same stale cursor makes every *restart* begin at the same place; within a process the cursor still
  advances. The progress store is Host-trusted (B3).
- **No outcome depends on position.** The cursor only decides *which* decisions a run examines.
  Every settlement still requires the B1/F1 evidence rules. An invalid, unreadable or replayed cursor
  only moves the starting point. A non-string, a non-commitment, a throwing `load` or a throwing
  `save` falls back to a random start or is ignored.
- **Bounded.** At most `maxDecisions` (1–1000) examinations and at most one `save` per run.
- **Idempotent and concurrent-safe.** Runs of one reconciler are serialized. Separate reconcilers
  keep separate cursors, AUTH-03 serializes appends, and an identical second settlement is
  `unchanged` (tested with four concurrent reconcilers).
- **Conflicts stay auditable.** A stuck decision is never settled. It stays in AUTH-03's unsettled
  list, and every revolution reports it with its reason.

### In-flight decisions

`inFlight` is still required (R4). It is now also fail-safe: only an answer of exactly `false` means
"not in flight"; any other value, or a throw, is treated as in flight. An in-flight decision is
reported `IN_FLIGHT`, is never settled, and costs one slot per revolution, so it cannot block others.
The registry itself is B3's: until B3 registers decisions from consumption to the coordinator's
return, F3 (the grace race) remains.

## 3. R5 — inventory integrity

### Root cause

A negative settlement (`NO_BOOTSTRAP_EVIDENCE`) was inferred from "no evidence in any configured
history". A namespace missing from the configuration made a committed bootstrap look like a
failure. The decision itself did not say which history to look in, so completeness of the inventory
was the only possible basis for a negative, and nothing could establish it.

### Remediation: make completeness unnecessary

1. **The decision names its history.** AUTH-03 bootstrap format **v2** signs
   `approvalRequestId = frontera.sovereign-status-bootstrap.v2:<encodeURIComponent(namespace)>:<bindingDigest>`.
   - There is exactly one canonical spelling. Alternative encodings, raw `:` and broken escapes
     are refused by both AUTH-03 and FV, which share pinned constants.
   - The FV authorizer builds the expected id from the binding itself (`bootstrapHumanDecisionInputs(binding)`),
     so a decision signed for another namespace than its binding's never authorizes that bootstrap.
   - `beginBootstrapAuthorityDecision` requires the namespace.
   - v1 is retired: a signed v1 decision row is `HUMAN_IDENTITY_STORE_CORRUPT`, and an unsigned v1
     challenge row is inert. Neither is ever read as a CORE-05 decision (tested with a correctly
     signed v1 row and with tampered challenge rows).
   - v1 was never composed by any Host. A pre-release test store holding v1 bootstrap rows is
     refused, not migrated.
2. **Evidence is written only to a store of the decision's namespace.** The coordinator refuses a
   request whose namespace is not its store's (`NAMESPACE_MISMATCH`). A store file is pinned to one
   namespace, and every decoded evidence record must carry it. Several *files* can be pinned to the
   same namespace (a fresh store, a backup copy), so which file is "the" history of a namespace is
   the Host configuration's claim (see "What it does not prove").
3. **A negative needs only the decision's own history.** `NO_BOOTSTRAP_EVIDENCE` is recorded only
   when the run's inventory snapshot:
   - holds a genuine, readable handle for the decision's namespace, whose read for the binding
     returned nothing; and
   - is unchanged when re-read just before the write.

   Only that history is read for the decision (review #3), so extra, unrelated or broken histories
   neither change nor block it. Evidence naming another namespace than the decision signed is a
   conflict (defence in depth: unreachable through genuine stores).
4. **A namespace never moves within one process (review #1).** The first file a reconciler sees for a
   namespace is pinned for that reconciler's lifetime, in memory only; nothing is pinned durably. A
   later snapshot mapping the namespace to another file leaves that namespace's decisions unresolved
   (`INVENTORY_HISTORY_MOVED`), however new its generation. Other namespaces proceed, and the pin
   never follows the move. A pin compares resolved path strings: two spellings of one file count as
   a move (fails safe); a different file at the same path is not detected (FV-P4D).

### v1 retirement and compatibility

A v1 bootstrap **decision** row (a signed, chained row) makes AUTH-03 refuse the **whole** identity
store (`HUMAN_IDENTITY_STORE_CORRUPT`), CORE-05 data included. A v1 **challenge** row (the unchained
`human_decision_challenges` table) is inert instead: it is returned as stored and refused by format
by every reader, so it is never issued, authorized, listed or recomputed. One unsigned row can
therefore never fail the store (re-review finding). This is deliberate:

- **It is AUTH-03's existing policy.** The projection of the signed chain refuses the entire store on
  any row it does not fully recognize: an unknown verdict, role, row kind, outcome kind or ceremony.
  Isolating one row would mean believing a signed chain while skipping some of its rows, a new and
  weaker policy.
- **Without it, v1 would cause domain confusion.** A v1 `approve` row would otherwise fall into the
  CORE-05 branch, whose evidence format is not allow-listed (pre-existing; review Info #7).
- **Denial of service through a decision row needs the signer.** Decision rows are signed and
  hash-chained, so writing a v1 one requires the store's authority signer, which already means full
  control of the store. Challenge rows are not signed, which is why a retired-format challenge is
  inert rather than corrupt. Pre-existing since AUTH-03 (#213), and unchanged here: a challenge row
  whose *verdict* is tampered with in place still makes the store refuse (Info).
- **No operational store can hold v1.** #245 is in no release (`v1.0.0` and `v1.0.0-pilot-ready`
  predate it). No Host file references the bootstrap API (pinned by `fv-p4c2b2-structure.test.ts`),
  and B3 has not happened.
- **Consequence.** A development or test store into which #245-era code wrote bootstrap decisions
  can no longer be opened by this code, for CORE-05 either. It must be discarded; it is never
  migrated. Any store that never held bootstrap decisions is unaffected.

### The inventory contract

A Host gives either `histories` (fixed, generation 0, validated when the reconciler is constructed)
or `inventory: () => { generation, histories } | undefined`, read once per run and again before any
negative write.

Each snapshot is validated, and each state below has its own reason:

| State | Result |
|---|---|
| Provider returns `undefined` (configuration not loaded) | unresolved `INVENTORY_NOT_LOADED` |
| Provider throws | unresolved `INVENTORY_UNAVAILABLE` |
| Not exactly `{ generation, histories }` (a `complete` flag included), a bad generation, 0 or > 256 histories, a non-object entry | unresolved `INVENTORY_INVALID` |
| A handle that is not genuine for its configured namespace and resolved file: a look-alike, a frozen copy, wrong namespace, wrong file | unresolved `INVENTORY_UNTRUSTED_HISTORY` |
| One namespace twice (including a copy of a history file, or one file under two spellings) | unresolved `INVENTORY_DUPLICATE_NAMESPACE` |
| One resolved file twice | unresolved `INVENTORY_DUPLICATE_DATABASE` |
| A generation lower than one already seen | unresolved `INVENTORY_STALE` |
| A generation already seen, naming other histories | unresolved `INVENTORY_GENERATION_REUSED` |
| The snapshot changed between the absence read and the negative write | unresolved `INVENTORY_CHANGED` |
| A namespace mapped to another file than first seen by this reconciler | unresolved `INVENTORY_HISTORY_MOVED`, for that namespace's decisions only |
| The decision's namespace is not in a valid snapshot | unresolved `HISTORY_NOT_IN_INVENTORY` |
| The decision's own history closed or unreadable | unresolved `HISTORY_UNAVAILABLE` |
| The evidence for the binding fails its integrity check | unresolved `HISTORY_CORRUPT` |
| Valid evidence naming this decision in its role | `bootstrap-committed` |
| Verified absence in the decision's own present history, after grace, not in flight | `bootstrap-not-committed` / `NO_BOOTSTRAP_EVIDENCE` |

**What absence means.** Absence of evidence is evidence of absence only for the one history the
decision signed, read through a genuine handle at the Host-configured path, under an unchanged
snapshot. No caller-supplied completeness is read or believed.

`INVENTORY_DUPLICATE_DATABASE` is defence in depth. A file is pinned to one namespace, so two
genuine handles to one file always share a namespace, and the namespace check reports them first.

### What it does not prove

- **Currentness of the file (FV-P4D).** Provenance proves origin, not currentness. A whole-file
  rollback of the decision's own history to a pre-commit copy, reopened at the configured path, is
  not detected. It yields a false **failure**, never a false success. This is tested and asserted as
  a known limitation.
- **Configuration authenticity (B3) — residual, Medium.** The generation and the namespace-to-file
  mapping come from the Host in-process. The highest generation and the namespace-to-file pin are
  kept per reconciler, so a *restarted* reconciler whose first configuration already maps a
  namespace to another file (a fresh `create: true` store, or a backup restored at another path)
  would read absence from the wrong file. That is a false `NO_BOOTSTRAP_EVIDENCE`, never a false
  success. A durable fix needs either a store-instance identity bound into the evidence and signed
  request (a history schema change), or B3 pinning each namespace's path in protected configuration.
  It is recorded as a B3 precondition.
- **Global latest state.** Namespace binding and provenance prove which file, by origin. They never
  prove the file is the latest history anywhere: no reconciler can assert global currentness from
  the local file alone.
- **A compromised process.** Out of scope, as before.

### Mandatory B3 acceptance requirements (from R5)

1. **Durable namespace identity.** A protected, durable namespace-to-database identity, so that no
   restart or reconfiguration can remap a namespace to another file without detection. Path pinning
   in protected configuration is the minimum; a store-instance identity bound into evidence is the
   stronger form.
2. **Quarantine on restore.** A restored or older history file stays in quarantine (FV-P4C-2A/2B1
   rules) and is never treated as continuity proof. No automatic bootstrap reset.
3. **Monotonic generations.** The inventory provider's generations come from that protected
   configuration.
4. **In-flight registration (F3).** Decisions are registered as in flight from consumption to the
   coordinator's return.

## 4. Preserved protections

These protections are unchanged and re-run:

- the F1 settlement capability (module-private, instance-bound, revocable, the bound port);
- genuine-handle provenance, with reads through the store's own statements;
- exact binding and `authorityRef` matching, and the requester's `operatorRef`;
- CORE-05 domain separation (`approval-authority/human-decision.ts` is byte-identical);
- `attest` / `approve` roles by different humans;
- explicit Kernel-Authority grants, with the percent-encoded scope (R2);
- the R3 counterpart rules;
- the required `inFlight` (R4).

## 5. Remaining B3 / B6 dependencies

- **B3 composition must:**
  - hold the settlement capability exclusively;
  - pin each namespace's history path in protected configuration, so no restart can remap it (review #1);
  - build the inventory provider from controlled Host configuration, with a monotonically
    increasing generation and genuine handles opened at the configured paths;
  - register decisions as in flight from consumption to the coordinator's return (F3);
  - optionally persist the cursor through `progress`;
  - not hand the composed identity store to the bootstrap subsystem.
- **B6:** a trusted status-currentness source.
- **FV-P4D:** an external witness, to detect whole-file rollback.

## 6. Security review

The implementing agent did a self-review. A separate review agent (same model family, read-only,
given the code and the threat list but not the author's conclusions) also reviewed the change twice:
once before publication (#1–9), and once on the published head (R-1 to R-5). No
independent human review has happened yet.

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | Medium | A namespace could be remapped to another file (a fresh or restored store) by a later configuration generation, giving a false `NO_BOOTSTRAP_EVIDENCE` | Mitigated: in-process namespace→file pin (`INVENTORY_HISTORY_MOVED`), tested. **Residual across restarts**: a B3 precondition (§3) |
| 2 | Low | The page key was not re-bound to the commitment read from the record (getter or proxy) | Fixed: `DECISION_MALFORMED`, tested |
| 3 | Low | One unreadable history blocked every decision org-wide | Fixed: only the decision's own history is read, tested |
| 4 | Low | A throwing decision skipped the rest of its page | Fixed: per-decision containment, tested |
| 5 | Low | A progress port that never answers stalled reconciliation; a stale `load` pins restarts | Fixed: 5 s bound, tested. Stale-load pinning documented (B3) |
| 6 | Low | The histories bound could be bypassed with a custom iterator | Fixed: bounded index copy |
| 7 | Info | AUTH-03's CORE-05 projection branch accepts any unknown evidence format with `approve`/`reject` (pre-existing) | Not changed here (CORE-05 untouched). Recommended: allow-list the CORE-05 format |
| 8 | Info | Generation and pin state are lost on restart | Documented (§3, B3) |
| 9 | Info | Namespaces the store accepts but the decision format refuses (control characters, lone surrogates) can never get a decision | Liveness only, fails closed |
| R-1 | Low/Medium | Re-review: one tampered *unsigned* challenge row set to the v1 format made the whole store throw, a new trigger for service-wide denial (introduced here) | Fixed: a retired-format challenge is inert, tested |
| R-2 | Low/Medium | Re-review: once one namespace moved, every namespace stayed unresolved | Fixed: only the moved namespace is refused, and the pin never follows; tested |
| R-3 | Low | Re-review: getter faults at grouping and in the malformed branch escaped containment | Fixed, tested |
| R-4 | Low | Re-review: a fault after a write is reported `SETTLEMENT_FAILED`; a late timed-out `save` can move the durable cursor backwards | Documented: no outcome affected |
| R-5 | Info | Pre-existing (#213): a challenge row whose verdict is tampered with in place makes the store refuse | Unchanged |

No Critical or High finding. The review found no path to a false `bootstrap-committed`.

FV-P4C-2B3A adds the foundations for these B3 requirements (`FV_HOST_COMPOSITION_FOUNDATIONS.md`): continuity records for durable namespace identity, the in-flight registry and the Host inventory provider. They remain uncomposed.
