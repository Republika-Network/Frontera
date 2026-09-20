# AOC Emergency Control

**Status:** internal capability. Opt-in at composition. No customer HTTP route, no SDK method, no intent field.

> **Has an operator administratively stopped execution for what is being
> attempted, and can that be established at all right now?**

Emergency Control is an **operational safety interlock** on the bounded-grant /
Governed Action path. It lets a trusted operator stop execution — globally, or
narrowed to one organization, actor, adapter or resource — and it makes an
unreadable control stop execution too.

It is deliberately small, and most of this document is about what it is *not*.

---

## 1. What it is not

| It is not | Because |
|---|---|
| a second policy engine | It evaluates no rule, resolves no context, reads no authority, and has no inputs beyond durable operator-set state and a handful of trusted identifiers. |
| a Kernel decision | It never produces `allowed`, `denied`, `indeterminate` or `approval_required`. `ADR-AUTHORITY-CONTROL-LAYERING.md` §4 makes the Kernel the only decision producer, and a second one is exactly what this must not become. |
| a grant revocation | It mutates no grant, writes nothing to the bounded-grant store, and records no `GrantRevocation`. A grant withheld by an active control is still valid, still unexpired, and still exercisable the moment the control is released. |
| an obligation | It discharges nothing and rejects nothing. |
| permanent | Every control is released by the same operator surface that set it. |
| the process-local `emergencyDeny` flag | See §9. That flag belongs to the older Action Enforcement path and is unchanged. |

What it *is*: a fail-closed gate that can **withhold an effect**, in its own
reason-code vocabulary, at four points in the lifecycle.

---

## 2. Where it sits in the lifecycle

```
BoundCustomerIdentity
  ↓
GovernedActionIntent                       validated closed; names no scope
  ↓
Kernel decision                            the only decision producer
  ↓
durably committed Governance Record
  ↓
replay historical execution if one exists  ← current state never rewrites this
  ↓
[1] EMERGENCY CONTROL — ADMISSION          orchestrator.ts
  ↓
grant terms (host grantPolicy)
  ↓
bounded-grant issuance
  └─ [2] EMERGENCY CONTROL — COMMIT BOUNDARY   issuance-core.ts, SYNCHRONOUS
  ↓
exercise
  ↓
authoritative bounded-grant reread
  ↓
grant containment assessment
  ↓
[3] EMERGENCY CONTROL — EXERCISE           grant-execution-service.ts
  ↓
server-side adapter routing
  └─ [4] EMERGENCY CONTROL — ADAPTER-SCOPED    execution-adapter-registry.ts
  ↓
selected ExecutionAdapter
  ↓
provider effect
```

Each checkpoint exists because the one before it is not sufficient on its own.

### [1] Admission — after replay, before grant terms

*After replay* because a stop declared today must not rewrite what an action did
yesterday (§7). *Before grant terms* because the next thing that happens is the
minting of **new bounded authority**, and an action nobody has attempted must
not acquire authority while execution is stopped.

Query: `organizationId`, `actorId`, `resource`. No adapter (routing has not run)
and no workflow (§4).

Withholding here writes nothing: no authorization artifact, no execution claim.

### [2] Commit boundary — inside the grant store's synchronous guard

An operator can activate a stop **after** admission and **before** the grant
store commits. A pre-issuance check alone leaves that window open, so the
control is re-read inside `BoundedGrantStorePort.issue`'s `commitGuard`, which
the store calls in its critical section with no `await` between the read that
decides and the write that records.

This is why `EmergencyControlReaderPort.read` is **synchronous**. It is the same
requirement `GrantAuthorityBindingQuery` already states for the authority
binding, for the same reason, and it is the reason the durable implementation is
`better-sqlite3` rather than an async client.

`emergency-control-commit-boundary.test.ts` proves both halves: that the read
really happens between the guard's entry and its exit, and that nothing on that
path contains `await`, `async`, `.then(`, `fetch(`, a filesystem call or a
Governance Store read.

### [3] Exercise — after the authoritative grant re-read, before the provider

A grant issued while the world was clear can be exercised minutes later. The
check therefore runs at effect time, after the store read and after the
containment assessment — so what it stops is an action that is genuinely covered
by a genuinely valid grant.

The distinguishing signature of this outcome is `assessment.usable === true` with
`withheldBy: 'emergency-control'`: *the grant covered the action, and the
interlock stopped it anyway.* That is a different situation from an expired or
revoked grant, with a different remedy, and the two are never collapsed.

### [4] Adapter-scoped — after trusted routing, before the child adapter

The execution runtime cannot know which provider adapter will translate an
action until server-side routing has resolved one. So the adapter-scoped control
is evaluated inside the composite registry, after selection and before the child
is invoked. See `AOC_EXECUTION_ADAPTER_REGISTRY.md`.

It is propagated back as one **typed signal**,
`EmergencyControlWithheldError`, which `GrantExecutionService` maps onto
`withheldBy: 'emergency-control'`. Every *other* adapter throw remains
`ADAPTER_ERROR`: an adapter cannot promote its own failure into an emergency
stop by throwing something that looks like one.

A stop here is never reported as `PROVIDER_REJECTED`. The provider was never
contacted.

---

## 3. The three answers, and why `unavailable` is not `clear`

```ts
type EmergencyControlAssessment =
  | { state: 'clear';       reasonCodes: [] }
  | { state: 'blocked';     reasonCodes: ['EMERGENCY_CONTROL_ACTIVE'];      matchedScopes: […] }
  | { state: 'unavailable'; reasonCodes: ['EMERGENCY_CONTROL_UNAVAILABLE'] }
```

`clear` proceeds. **Both of the others withhold.**

"The stop could not be read" and "no stop is active" are different facts, and
treating the first as the second turns an outage into permission — which is the
one direction an operational interlock must never take. Every path to
`unavailable` is covered: a reader that throws, a reader that returns something
that is not an assessment, a closed store, a malformed query, a row whose digest
does not match its fields, and a reader that (in violation of its own contract)
returns a promise.

`readEmergencyControl(reader, query)` is the single helper all four checkpoints
call, so the fail-closed discipline is written once rather than re-derived four
times. A reader that is simply **not configured** returns `clear` — that is the
"capability absent" case, and it is explicit rather than incidental.

---

## 4. Scopes

Exact matching only. No glob, no regex, no prefix: a wider matching language is
a place for an operator to believe they stopped more than they did, and this
phase does not introduce one.

| Scope | Value | Supplied by |
|---|---|---|
| `global` | — | always applies, to every query including `{}` |
| `organization` | the bound organization | customer identity admission |
| `actor` | the bound Frontera actor | customer identity admission; at exercise, the grant's own `subject` read from the store |
| `resource` | the resource scope | the committed Kernel decision |
| `adapter` | the **selected child adapter** | trusted server-side routing, checkpoint [4] only |
| `workflow` | — | **nothing today.** See below. |

**Monotonic safety.** If any applicable active control matches, execution is
blocked. A narrower control being clear never overrides a broader one being
active: "clear" is the absence of a match, not a vote. `global` active plus
`organization` explicitly released is still blocked.

### The workflow scope has no canonical source today

`workflow` is in the model because the architecture target names it, and it
matches exactly when a query states a `workflowId`. **No Governed Action path
supplies one**, and that is deliberate: `GovernedActionIntent` has no workflow
field, `KernelEvaluationRequest` has no canonical workflow identity, and adding a
caller-controlled one would let a caller choose which controls apply to it.

So a control declared on `workflow` is currently **inert** on the Governed
Action path. It becomes meaningful when a trusted workflow source exists — not
before. This is stated rather than hidden, and
`emergency-control-reader.test.ts` pins both halves: the scope matches exactly
when queried, and no governed-action query ever states it.

---

## 5. Reason codes

Two, both prefixed, both disjoint from every other vocabulary in the repository
(`emergency-control-boundaries.test.ts` checks this against the Kernel,
obligation, grant-issuance, grant-exercise and provider-failure vocabularies).

| Code | Meaning |
|---|---|
| `EMERGENCY_CONTROL_ACTIVE` | An applicable control is active. Nothing was revoked and no decision was rewritten. |
| `EMERGENCY_CONTROL_UNAVAILABLE` | The current state could not be established. Reported, never assumed away. |

There is deliberately **no** `GOVERNED_ACTION_EMERGENCY_DENIED`: orchestration
owns `GOVERNED_ACTION_*` only where no lower layer has a canonical vocabulary,
and this layer has one.

A commit-boundary refusal is reported as `EMERGENCY_CONTROL_*`, **not** as
`GRANT_CORRELATION_INVALID` — which is what the grant store's guard reports when
the synchronous revalidation returns `undefined`. The reason is captured in a
variable owned by the single `issueFromDecision` call and re-attached to an
additive `emergency-control-withheld` outcome, so an operator is never sent
hunting a correlation bug that does not exist.

---

## 6. Result semantics

| Situation | Governed action result |
|---|---|
| Kernel denied | `denied` |
| Kernel indeterminate | `indeterminate` |
| approval required | `withheld` / `approval` |
| blocking obligation | `withheld` / `obligations` |
| **emergency control active or unreadable** | **`withheld` / `emergency-control`** |
| ordinary grant issuance refusal | `withheld` / `grant` |
| authority binding unavailable | `withheld` / `authority-binding` |
| grant exercise unusable | `withheld` / `exercise` |
| provider rejects or fails | `execution_failed` |
| adapter throws | `execution_failed` / `ADAPTER_ERROR` |
| routing resolves no adapter | `execution_failed` / `ADAPTER_ERROR` |
| attempt exists, effect unknown | `execution_unconfirmed` |

`withheld / emergency-control` is never collapsed into `denied`, a provider
failure, a revocation or a system error.

---

## 7. Historical replay is never rewritten

The ledger's only behavioural use stays **negative**: this execution identity was
already attempted, so do not attempt it again. Current operational state is not
evidence about a past effect.

| Case | State now | Result |
|---|---|---|
| A | executed and recorded; stop now active | `executed`, `replayed: true`, no new grant, no adapter call |
| — | `execution_failed` recorded; stop now active | the same failure, replayed |
| — | grant-exercise withholding recorded; stop now active | the **grant-exercise** withholding, replayed |
| — | emergency withholding recorded; stop now cleared | the **emergency-control** withholding, replayed |
| B | attempt recorded, no outcome; any state | `execution_unconfirmed`, no adapter call |
| C | decision exists, no attempt; stop now active | `withheld` / `emergency-control`, no adapter call |
| D | stop was active at admission, no execution claim written; stop later cleared | the retry proceeds — no effect attempt ever occurred |
| E | stop activates after the execution claim, before the adapter | withheld at exercise, **durably recorded** as an emergency withholding, and replayed as one |

### Ledger encoding

A withheld effect is recorded as `withheld:<layer>:<CODE>,<CODE>…` — the layer
that withheld it, then that layer's reason codes in their own stable order.

- Deterministic and bounded: a layer from a closed two-member set, at least one
  code, every code from **that layer's own** closed vocabulary, none repeated.
- The layer is **recorded**, not inferred from the codes. Inferring it would make
  the vocabularies' disjointness a correctness requirement of the replay path,
  and a code added to the wrong constant would silently re-label history.
- A stored value that does not decode exactly is reported raw and matches no
  known outcome: a malformed or tampered row replays as "attempted, outcome
  unknown", never as a withholding reason and never as anything that permits an
  effect.
- The Prompt 3 form `withheld:<CODE>…` still reads, as `grant-exercise` — the
  only layer that could have written one.

---

## 8. The durable store

**Feature-level contract, enterprise-level implementation.**
`src/features/emergency-control-runtime` holds the port, the vocabulary, the
scope algebra and a process-local store for focused tests.
`src/enterprise/emergency-control` holds the SQLite implementation.

### Schema — `aoc.emergency-control-store.schema.v1`

```sql
CREATE TABLE emergency_controls (
  control_key   TEXT PRIMARY KEY,   -- 'global' | '<scope>:<value>'
  scope         TEXT NOT NULL,
  scope_value   TEXT,               -- NULL only for global
  active        INTEGER NOT NULL,   -- 0 | 1
  issuer_ref    TEXT NOT NULL,      -- operator audit; never returned by a read
  declared_at   TEXT NOT NULL,
  record_digest TEXT NOT NULL,      -- sha256 over the canonical record, INCLUDING `active`
  committed_at  TEXT NOT NULL,
  schema_version TEXT NOT NULL
);
```

`active` is a flag rather than a row's presence, so a released control keeps its
history instead of vanishing.

### Properties

1. **Its own file.** An operator must be able to back up, restore and rotate the
   kill switch independently of the records it governs. Configured by
   `AOC_ENTERPRISE_EMERGENCY_CONTROL_SQLITE_PATH`, default
   `.data/emergency-controls.sqlite`.
2. **One transaction per mutation**, `journal_mode = WAL`,
   `synchronous = FULL` — an acknowledged `activate` is durable before it
   returns.
3. **Every read verifies.** A row whose digest does not match its fields, whose
   scope is outside the closed vocabulary, whose `active` is not `0`/`1`, whose
   `scope_value` disagrees with its scope, or which is filed under a key that
   does not match its own scope and value, is never interpreted: the read reports
   `unavailable`. It is never repaired into `clear`.
4. **Malformed writes are refused**, so nothing unreadable is stored through the
   typed writer in the first place.
5. **Scoped fail-closed.** Only the rows that could apply are fetched. A corrupt
   row for an organization this query is not about does not block that query —
   stopping every tenant because one unrelated row is unreadable would be an
   availability failure nobody chose, and would make nobody safer.
6. **A closed store withholds.** `read` returns `unavailable`; the operator
   mutations throw, because an operator is entitled to know a stop did not take.

### What the digest does not do

It is **unkeyed SHA-256** — storage integrity, not cryptographic authenticity,
exactly as `storedGrantRecordDigest` and the Governance Store's `computeDigest`
already are. It detects a flipped `active` flag. It does **not** stop a writer
who can re-seal a row, and it cannot detect a **deleted** row: a writer with raw
database access can clear a control, and
`emergency-control-durability.test.ts` records that plainly rather than papering
over it. Attaching a key boundary is later work;
`AUTHORITATIVE_GRANT_STORE.md` §10 states where it attaches.

### Deployment scope

Proven for this repository's existing **single-host** deployment assumption — the
same assumption `AUTHORITATIVE_GRANT_STORE.md` §12 records for the grant store.
Within one host, `better-sqlite3`'s synchronous access and SQLite's own write
serialization make a committed control visible to the very next read. Across
hosts sharing a filesystem, SQLite's locking applies and `busy_timeout` bounds
the wait.

**No claim of multi-region or distributed linearizability is made here, and none
should be repeated elsewhere.** "Global" names a *scope*, not a topology: a
`global` control stops every governed action served by the Hosts reading that
database file, and says nothing about a Host reading a different one.

The in-memory store is for focused tests and single-process development. It is
**not durable** and is never described as such: it loses every control on
restart, which for a control fails *open*.

---

## 9. The existing process-local `emergencyDeny` is unchanged

`ActionEnforcementRuntime.emergencyDeny`, `EmergencyDenyPolicy` and
`setEmergencyDeny()` belong to the older Action Enforcement path. They are
**untouched by this phase**: same behaviour, same surface, same tests.

- The durable `EmergencyControlReaderPort` is the safety interlock for the
  **bounded-grant / Governed Action path** — and only that path.
- The process-local flag is the stop for the **Action Enforcement preflight
  path** — and only that path. It is in-process memory and does not survive a
  restart.
- Neither is wired to the other, and this document does not claim the old flag
  is now durable.

Converging them is plausible follow-up work — one durable control plane feeding
both — but it is a behavioural change to an existing path and is deliberately
out of scope here.

---

## 10. Composition

```ts
const enterprise = await createEnterprise({
  // … kernel, identity admission, authorityControlledExecution …
  emergencyControl: { enabled: true },                     // composed here, durable when persistence is sqlite
  // or: emergencyControl: { enabled: true, store: myStore } // host-opened, host-owned
});

enterprise.emergencyControlAdministration?.activate({
  scope: 'organization',
  value: 'org-acme',
  issuerRef: 'operator:on-call',
  declaredAt: new Date().toISOString(),
});
```

- **Omitting it changes nothing.** No check runs, no store is opened, and every
  existing behaviour is byte-identical.
- **One instance, four checkpoints.** The composition root hands the same reader
  to the orchestrator, the issuance core, the exercise gate and the registry.
  Four readers would be four worlds, and an operator stopping one of them would
  believe they had stopped execution.
- **Read-only where it executes.** Everything on the execution path is typed
  against `EmergencyControlReaderPort`, which declares no mutation — and what it
  is *handed* is a fresh one-method object built by
  `createEmergencyControlReader(store)`, so `activate` and `release` are
  unreachable to a cast as well as to the compiler. It is the same move customer
  admission already makes with `createKernelAuthoritySubjectBindingReader`. Only
  the host holds `EmergencyControlStorePort`.
- **Ownership.** A host-supplied store is never closed from here; a store this
  root opened is closed on shutdown — the same discipline the bounded-grant
  store follows.
- **Fail-closed selection.** A configured SQLite store that cannot be opened
  raises rather than being replaced by a process-local one.

### No customer surface

No HTTP route, no SDK method, no `GovernedActionIntent` field, no path through
`AocEnterprise.evaluate()`, and nothing an actor could use to disable its own
stop. The Enterprise barrel re-exports **types only**: a published-package
consumer is never handed a factory for a store that can stop or resume a
deployment. `emergency-control-composition.test.ts` pins each of these.

`AocEnterprise.emergencyControlAdministration` is a **trusted operator** surface,
exposed for the same reason `kernelAuthorityProvisioning` is: a deployment's own
administration code needs to stop and resume execution without reaching into
internals. An application handed an `AocEnterprise` should be handed the
evaluation surface, not this object.

---

## 11. Limitations

- The host process is trusted. Code holding the store can release any control,
  and code holding a raw adapter reference bypasses Frontera entirely
  (`SEC-TRUST-001`, `SEC-TRUST-004`).
- Child adapters are trusted code.
- No process or egress containment exists.
- The record digest detects mutation, not deletion, and not a writer who
  re-seals.
- Single-host durability only; no distributed control plane.
- The `workflow` scope has no canonical Governed Action source (§4).
- Only the bounded-grant / Governed Action path honours these controls. The
  Action Enforcement path, the Sovereign Access path and the Content Protection
  path do not (§9, and `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §5).
- Emergency control is not grant revocation: clearing a control restores
  execution under grants that were never touched.
