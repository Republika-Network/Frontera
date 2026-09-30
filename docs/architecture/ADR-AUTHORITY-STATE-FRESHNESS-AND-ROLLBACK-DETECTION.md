# ADR — Authority State Freshness & Rollback Detection (CORE-07)

- **Status:** Accepted — CORE-07, 2026-09-29 (branch `feat/core-07-authority-state-freshness`)
- **Roadmap item:** `docs/architecture/FRONTERA-MASTER-PLAN.md` §9 CORE-07
- **Closes:** AA-003 / GS-002 — **within the declared freshness-anchor scope only** (§9)
- **Security detail:** `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` §30, `docs/security/AUTHORITATIVE_GRANT_STORE.md` §17
- **Invariants:** SEC-INV-164 … SEC-INV-175 (`docs/security/SECURITY_INVARIANTS.md`)
- **Code:** `src/enterprise/authority-state-freshness/`, the `freshness` option of the three durable authority stores, the freshness boundary in `src/enterprise/composition/composition-root.ts`, `scripts/run-reference-authority-state-witness.mjs`, `scripts/enroll-authority-state-freshness.mjs`

## 1. Context — the defect, reproduced

Every durable authority store signs its state head, and every authoritative
read verifies the head and recomputes it from the rows:

| Store | Signed head (unchanged by CORE-07) | Monotonic position | Digest |
|---|---|---|---|
| Bounded grants (CORE-01) | revocation-state commitment `{storeId, sequence, revocationSetDigest}` | `sequence` = revocations ever committed | `revocationSetDigest` |
| Obligation discharges (CORE-04) | chain head `{storeId, organizationId, sequence, chainDigest}` | `sequence` = rows | `chainDigest` |
| Approvals (CORE-05) | chain head `{storeId, organizationId, sequence, chainDigest}` | `sequence` = rows | `chainDigest` |

A signature authenticates a state; it cannot prove the state is the **newest**.
A captured earlier head verifies exactly as well as the current one. Each
store kept an in-process freshness witness, so a rollback under a *running*
process was refused — and the witness vanished at restart.

**Reproduced on `main @ 5cf562d` before any change** (a scratch script over
the baseline build; the same attack is now the inverted test): an
authenticated durable grant store (store `51dac46b…`) issued grant G at
revocation sequence 0 (`sha256:b2c710ce…`); the whole database was copied with
the store closed; G was revoked (sequence 1, `sha256:02886059…`) and was
withheld with **0** adapter calls; the process stopped; the copied files were
restored wholesale; the restarted store **opened as authentic**, reported
`healthy`, `revocationState: verified`, `revocationSequence: 0`, read G with
no revocation, and the execution path **executed G — 1 adapter call**. That is
AA-003 / GS-002 exactly.

Rollback does not point the same way in every store, and CORE-07 does not
pretend it does:

- **Grants.** Restoring a pre-revocation state restores revoked authority
  (the attack above). Removing a *grant* by rollback loses authority — fail
  closed — and grant issuance does not move the revocation sequence, so it is
  not anchored separately: a restored state that is missing a later grant
  withholds, and a later grant row transplanted into an older state is still a
  grant this key genuinely issued, whose later revocation (if any) advanced the
  sequence the witness now holds.
- **Obligations.** Reports are recorded in strictly increasing observation
  time and satisfaction is terminal, so an earlier prefix can only *remove*
  satisfaction (CORE-04). A rollback withholds; it never manufactures
  authority.
- **Approvals.** A prefix **can** be more permissive than its whole — approved
  before a revocation or a rejection. A restored prefix made a revoked
  approval usable again after a restart (pinned by the former CORE-05
  residual test).

The requirement is **one freshness story for all authority-bearing
authenticated state**, not a claim that every rollback expands authority.

## 2. Decision

### 2.1 The anchor lives outside the store's restore domain

An authority database cannot prove its own freshness. Anything stored inside
the same SQLite file, beside it, in the same backup set, in process memory, in
an environment variable, or in the same VM snapshot is rolled back together
with the state it claims to witness. CORE-07 therefore anchors each store's
already-signed head at an **external authority-state witness** — a separate
service whose durable state must live in a different volume, backup set and
snapshot schedule (§8).

A blockchain-specific anchor inside CORE is a non-goal. The boundary is a
vendor-neutral protocol and a transport port; an adapter may put a cloud
ledger, a trusted timestamping service or a chain behind a server that speaks
it. No such SDK enters CORE (a structural test pins it).

### 2.2 Module and roles

`src/enterprise/authority-state-freshness/` — an enterprise composition edge,
not Kernel, not payment code, and **not** the external signer module:

| File | Role |
|---|---|
| `checkpoint.ts` | the one checkpoint model and its canonical bytes; mappers from each store's signed head |
| `protocol.ts` | `frontera.authority-state-witness.v1`: operations, fixed paths, receipt canonical bytes and signing domain, strict parsers |
| `transport.ts`, `http-transport.ts` | the transport port and the reference HTTP transport |
| `witness-client.ts` | `establishAuthorityStateWitness`: pinned identity, per-call challenge, receipt verification, bounded retries, health monitor — the `AuthorityStateFreshnessAnchor` |
| `session.ts` | `createAuthorityStateFreshnessBoundary`: genesis enrollment, startup reconciliation, the prepare → commit → finalize transition, the in-process floor, the probe |
| `reference/reference-witness-service.ts` | the loopback reference witness |

Two roles, never conflated: the **authority signer** proves a trusted
authority key vouched for state bytes (CORE-02); the **freshness witness**
proves a state is not older than the state already witnessed. They have
different keys and different credentials — composition refuses a witness key
that is also a trusted authority verification key, and a witness credential
that is also the external signer's; the environment validator refuses the
same credential for both.

### 2.3 The canonical checkpoint

```
AuthorityStateCheckpoint {
  stateKind       'bounded-grant-revocation-state' | 'obligation-discharge-state' | 'approval-state'   (closed)
  organizationId  the slot's organization (for grants: the Host's organization)
  storeId         the store's random identity
  sequence        the head's own monotonic sequence (no second counter)
  stateDigest     revocationSetDigest | chainDigest
}
```

Canonical bytes (`serializeAuthorityStateCheckpoint`): versioned
(`frontera.authority-state-checkpoint.v1`), keys fixed and sorted, nothing
optional, `sequence` as an integer. Two checkpoints serialize equal exactly
when they denote the same state. A sequence alone never identifies a state.

**The binding.** The witness keys a checkpoint by the **slot**
`(stateKind, organizationId)` and records `storeId` inside it. So kinds cannot
collide (a revocation sequence is not an approval sequence), organizations
cannot be substituted, and a *different* store presented under an occupied
slot — a swapped-in file, a replaced store, a store from another deployment
signed by the same key — is a substitution, refused
(`AUTHORITY_FRESHNESS_BINDING_MISMATCH`). One slot per kind per organization
means one witness namespace per deployment: two deployments serving the same
organization must not share a witness.

No store signature, signing domain, canonical byte format, schema or schema
version changed: CORE-07 anchors the already-authenticated heads.

### 2.4 The witness protocol — compare-and-advance only

Five structured operations, one fixed path each, every body parsed with exact
keys against closed shapes; no put, no arbitrary key, no caller-supplied
path, no "sign these bytes":

| Operation | Semantics |
|---|---|
| `identity` | which witness this is, and its operation set |
| `read` | the slot: `unbound`, or `{storeId, committed, pending?}` |
| `enroll` | create the slot. `genesis` (sequence 0) or `baseline` (the ceremony, §2.7). Never rebinds: an occupied slot answers `conflict` unless it holds exactly that state |
| `prepare` | `expected` must be exactly the committed checkpoint with no pending successor; `proposed` (sequence + 1, same slot and store) becomes **pending**. A repeat of the exact same prepare is the same prepare; any other is `conflict` |
| `finalize` | the pending checkpoint becomes committed. A repeat is idempotent; anything else is `conflict` |

The reference witness applies each operation inside one `BEGIN IMMEDIATE`
transaction over its own SQLite file, with conditional updates — so of any
number of concurrent prepares from the same committed state exactly one wins
(qualified at the witness and across two store instances, §6). Every change is
appended to an append-only history; triggers forbid deleting a binding,
changing its store, or moving it backwards. It detects: a lower sequence, the
same sequence with another digest, another store under the slot, another kind
or organization (another slot), a stale expected checkpoint, and concurrent
forks. Last-writer-wins is impossible by construction.

### 2.5 Trust: pinned witness identity, signed receipts, no TOFU

The Host is configured with the witness's **id and Ed25519 public key**
(`AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_ID`,
`AOC_ENTERPRISE_AUTHORITY_FRESHNESS_WITNESS_PUBLIC_KEY`). Trust is never
learned from the witness. On **every** call:

1. a fresh random 32-byte challenge goes out;
2. the answer must be exactly `{receipt, signature}`, the receipt exactly the
   protocol shape, and the signature must verify under the **pinned** key over
   `frontera:authority-state-witness:receipt:v1\n` + the canonical receipt
   (rebuilt locally, never taken from the wire);
3. the receipt must name the pinned witness id, the operation asked, the
   challenge sent, and the binding asked about;
4. a receipt whose outcome says the operation was applied (`enrolled`,
   `prepared`, `finalized`) must hold exactly the store and checkpoint(s)
   that operation was asked to apply — otherwise `MALFORMED_RESPONSE`.

A recorded receipt therefore cannot be replayed to a later call; a receipt
about one slot cannot answer another; an endpoint that is not the pinned
witness can deny service but cannot make a stale state look current. The
startup handshake (`identity`) proves possession of the pinned key before any
store is opened. The receipt domain is disjoint from every authority-artifact
domain.

The deployment configuration remains a trust root — whoever can rewrite the
pinned witness key can point the Host at a witness of their choosing. That is
**AA-002**, unchanged and still open.

### 2.6 Genesis — enrolled before it exists

For a **new**, empty store: the store reads its slot; if unbound it generates
a store id, enrolls `genesis` at the witness, and only then commits its local
genesis. A crash in between leaves a witnessed genesis and an empty file; the
next open finds the slot holding a pure genesis (sequence 0, the digest that
store id's genesis must have, nothing pending) and **adopts that store id** —
genesis state is deterministic from it and holds no authority, so recreating
it is provably safe. A slot holding anything beyond genesis refuses an empty
file (`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`): a deleted or replaced store is
never re-initialized. A lost enrollment race is re-read once and the winner's
genesis adopted. The existing rule stands unchanged: a non-empty or partial
local store is never initialized as new.

### 2.7 Existing stores — an explicit ceremony, never automatic

A store with authenticated state and **no** binding — any existing deployment
upgraded to CORE-07, or a store created before a witness was configured, at
genesis or beyond — is **refused** (`AUTHORITY_FRESHNESS_UNBOUND_STORE`).
Auto-enrolling it would let an attacker restore an old store, reset the
witness binding, restart, and have Frontera call the old state current.

Enrollment is an explicit, trusted, one-shot operator action:
`enrollExistingAuthorityStores(configuration, context, kinds)` (trusted
in-process) and its operator command `scripts/enroll-authority-state-freshness.mjs
--operator <id> --attest-current-state --store grants|obligations|approvals`.
It opens each store exactly as the Host would — the full signed history
verified — and enrolls its current head as a `baseline`. The context
`{ operator: true, operatorId, attestation: 'verified-local-state-is-current' }`
is own-data-property validated; no composition path constructs one (pinned
structurally), and there is no HTTP route (the API stays at 36 endpoints). It
never creates a store and never rebinds an occupied slot
(`AUTHORITY_FRESHNESS_ALREADY_ENROLLED`).

**Unavoidable limitation:** CORE-07 cannot know whether a store was rolled
back *before* its first trusted enrollment. The operator's attestation is the
baseline; after it, regression is detected.

### 2.8 Startup — freshness before any authority is handed out

Each durable store, at open, verifies its local head cryptographically (its
existing code), then — **before** key-rotation re-attestation and before the
store object is returned — reads its slot and reconciles:

| Witness | Local | Result |
|---|---|---|
| unbound | any | refused — `UNBOUND_STORE` (enroll explicitly) |
| other store id | any | refused — `BINDING_MISMATCH` |
| committed C, no pending | = C | **ready** |
| committed C | seq < C | refused — `ROLLBACK_DETECTED` |
| committed C | seq = C, other digest | refused — `FORK_DETECTED` |
| committed C, no pending | seq > C | refused — `FORK_DETECTED` (never anchored) |
| committed C, pending P | = P exactly | **finalize P**, ready (crash after local commit) |
| committed C, pending P | = C | refused — `PENDING_RECOVERY` (§2.9 case A) |
| committed C, pending P | seq = P, other digest | refused — `FORK_DETECTED` |

The local head compared is read **after** the witness answer, so another
process's transition completing in between can only make it newer. The two
verdicts such a transition can legitimately produce — a local head ahead of
the witness answer, or a prepared successor the file does not hold yet — are
accepted only when a second witness read shows the witness held still across
the local read (at most three rereads; a witness that keeps moving refuses the
open with `CONFLICT`). Every other refusal needs no second read: the witness
only moves forward, and finalizes only what the store already holds.

A refusal throws from the store constructor, so `createEnterprise` fails and
the secure Host never listens: detection happens before any grant can be
read, exercised or claimed. (Parity case: a grant store whose *local* state
does not verify at open still opens and answers nothing, exactly as before
CORE-07, and never acquires a session later — so the Host still refuses with
`HOST_NOT_HEALTHY` naming the module.)

### 2.9 Crash consistency — prepare, local commit, finalize

The naive protocol — commit locally, anchor afterwards — has a fatal window:
revocation committed, crash before anchoring, old snapshot restored, restart
sees old DB == old anchor, revoked authority returns. CORE-07 closes it:

```
current Cn (verified locally)
  1. construct and sign Cn+1                          (existing store code, outside any transaction)
  2. witness PREPARE  expected = Cn, proposed = Cn+1  (network; no transaction open)
  3. local COMMIT Cn+1                                (synchronous BEGIN IMMEDIATE; revalidates Cn)
  4. witness FINALIZE Cn+1                            (network; after the commit)
```

From PREPARE on, the witness no longer treats Cn as unconditionally current.

| Crash / failure | Witness | Local | Recovery |
|---|---|---|---|
| prepare fails (C2) | committed Cn | Cn | nothing was written; the mutation reports the failure |
| after prepare, before local commit (**A**, C3) | pending Cn+1 | Cn | **fail closed** — indistinguishable from "committed Cn+1, then restored Cn"; never auto-abandoned |
| after local commit, before finalize (**B**, C4) | pending Cn+1 | Cn+1 | verified local Cn+1 == pending → finalize at next start (or before this process's next transition, or by the probe) |
| committed newer (**C**, C5) | committed Cn+1 | Cn | rollback — refused |
| committed, same (**D**) | committed Cn+1 | Cn+1 | valid |
| committed, other digest (**E**, C6) | committed Cn+1 | Cn+1′ | fork — refused |

An acknowledged transition is therefore never erasable by restoring a
snapshot merely because the process crashed before anchoring it: once the
local commit returns, the witness already holds the new state (pending or
committed), so restoring the old one is refused. A revocation is acknowledged
after step 3; a finalize that does not arrive leaves local and witness-pending
in exact agreement and is completed later — so a crash after the local commit
never bricks a valid state.

If a prepared transition's local commit does not complete (an I/O failure, a
local state that changed underneath — impossible for conforming writers,
since each must win its own prepare first), the session becomes
`pending-recovery` for the life of the process and the store refuses every
authority read. There is **no abort and no force-clear API**: resolving a
pending transition the local store does not hold is trusted operational
recovery (PROD-02's backup / restore procedures), outside CORE-07.

### 2.10 No network inside a SQLite write transaction

The CORE-02 principle holds: `prepare` completes before the store opens its
write transaction; the transaction revalidates that the local state is still
the planned one and commits synchronously; `finalize` runs after it commits.
No `await` exists inside any commit handed to a transition (pinned
structurally).

### 2.11 Concurrency

Two writers (processes) that verified the same Cn and each planned Cn+1: only
one `prepare` wins at the witness. The loser gets `conflict`, **commits
nothing it planned**, re-plans on the winner's committed state, and retries —
at most three attempts, then refuses with nothing written. The one conflict a
writer resolves itself: the witness holding, pending, exactly the head it just
verified locally (another writer's commit whose finalize never arrived) — it
finalizes that, then prepares once more.

### 2.12 Running process, reads and availability

Every authoritative read passes the verified local head through the
session's **floor** — the newest checkpoint this process established at
startup or committed since. Lower sequence → `ROLLBACK_DETECTED`; same
sequence, other digest → `FORK_DETECTED`. Local, synchronous, no network. The
discharge and approval stores' own in-process witnesses were strengthened to
remember **sequence and digest** (they remembered a bare number); the grant
store's CORE-01 witness is unchanged.

**Availability — the explicit decision:**

| Moment | Witness unavailable | Why |
|---|---|---|
| Cold start | the store refuses to open; the secure Host does not start (`AUTHORITY_FRESHNESS_UNAVAILABLE`) | freshness cannot be established |
| Authority mutation (revocation, discharge append, approval append) | refused, **nothing written** | no transition without its prepare |
| Existing reads / exercise after an established start | **continue**; Host `degraded`, still ready | cross-restart freshness was established at startup; the same process is alive; every read passes the floor; no freshness-relevant mutation is possible; local rollback and fork are still refused |

There is no fallback in any row: an external mode never silently degrades to
process-only freshness, and a process restarted during the outage does not
start. This mirrors the running process being itself a freshness witness for
state it has already established.

**The cost, stated:** revocation now needs the witness as well as the signer
(AA-004's shape, extended — `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §30). During a
witness outage a revocation fails loudly and the grant stays exercisable until
the witness returns; the emergency control (a separate store, not anchored)
remains the stop mechanism that does not depend on it.

**Topology.** The repository composes one Enterprise Host per organization
(`AUTHORITATIVE_GRANT_STORE.md` §12.1, D-GS2). The witness's compare-and-advance
fences cross-process *writers* (§2.11). Reads rely on this process's floor, so
a process that never observed another process's transition learns of a
rollback past it only at its next start, its next own transition, or the
health probe — not on every read. Linearizable multi-process reads remain
unclaimed (R-GS-07).

**The probe under concurrent writers.** The probe reads the witness, then the
local head, and settles exactly as startup does (§2.8): a legitimate
transition by another process between the two reads is never classified as a
fork or a rollback. What it finds then decides how long it lasts:

| Probe finds (witness held still across the local read) | Session | Reads |
|---|---|---|
| older local head, other digest at a witnessed position, other store, unbound | `regressed` / `forked` / `unbound` — **sticky** for the life of the process | refused |
| a prepared successor the local store does not hold | `pending-recovery` — **not** sticky: from a running process it is also what another process's in-flight transition looks like | refused while it lasts; resumes when the local store holds exactly that successor (the case a restart finalizes) or the next probe finds a consistent state |
| a witness that kept moving through three rereads | unchanged | unchanged |

A genuine pending-recovery (a writer that crashed after `prepare`, or a
committed transition rolled back underneath) therefore stays refused: nothing
this process says can make the witness drop a pending successor, and a
finalized one that the file does not hold is a rollback, which is sticky.

### 2.13 Health, posture, failure codes

- **Posture** `authorityFreshness`: `external` only when every durable
  authority store composed here was opened under this root's boundary (a
  runtime brand the stores set themselves); `not-composed` otherwise.
- **Health** `authorityFreshness`: the witness id, the witness's last state,
  and per store `{stateKind, status, reason?, sequence}` with `status` ∈
  `ready | unavailable | regressed | forked | pending-recovery | unbound`. A
  failed store status makes the Host **unhealthy** (so `/ready` is 503); a
  witness outage after an established start makes it **degraded**. Probes are
  single-flight and at most one round per
  `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_PROBE_INTERVAL_MS`. No credential,
  endpoint path, receipt, signature, digest or path appears.
- **Closed codes** (`AuthorityStateFreshnessError.code`):
  `UNAVAILABLE` (the only retryable one: timeout, unreachable, 429, 5xx),
  `AUTHENTICATION_FAILED`, `REFUSED` (4xx, redirects — never followed),
  `MALFORMED_RESPONSE`, `WITNESS_UNAUTHENTIC`, `PROTOCOL_UNSUPPORTED`,
  `BINDING_MISMATCH`, `ROLLBACK_DETECTED`, `FORK_DETECTED`, `PENDING_RECOVERY`,
  `UNBOUND_STORE`, `ALREADY_ENROLLED`, `CONFLICT`, `CONFIGURATION_INVALID` —
  each prefixed `AUTHORITY_FRESHNESS_`. A grant exercise on a refusing store
  is withheld before the adapter (`GRANT_EXERCISE_…` from the exercise gate,
  the store's closed code underneath).

### 2.14 Secure Host vs lenient embedding

- The **secure Host** (`production` / `staging`) **requires**
  `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE=external` with endpoint, token,
  witness id and witness public key (`HOST_AUTHORITY_FRESHNESS_REQUIRED`), and
  its posture gate requires `authorityFreshness: external`. It does not run
  authenticated durable authority with AA-003 open.
- `createEnterprise()` stays a lenient embedding surface: `mode` absent (or
  `none`) composes no witness, posture says `not-composed`, and anti-rollback
  across a restart is **not claimed** (a scoped test pins that the restored
  state is believed there). In-memory stores hold no cross-restart state and
  are never anchored.
- Under `external`, the composition root builds every authority store itself
  and adopts **no** host-supplied grant, obligation or approval store (the
  CORE-02R rule, extended).
- Pure in-memory development needs no external service.

### 2.15 Configuration

| Variable | Rule |
|---|---|
| `AOC_ENTERPRISE_AUTHORITY_FRESHNESS_MODE` | `none` \| `external` (closed; absent = `none`). Any other witness variable without `external` is refused |
| `…_ENDPOINT` | base URL; `https`, or `http` to loopback only; no path, query, fragment or userinfo |
| `…_TOKEN` | ≥ 32 characters, no whitespace; **never the signer's credential** |
| `…_WITNESS_ID` | 1–128 of `[A-Za-z0-9._:-]` |
| `…_WITNESS_PUBLIC_KEY` | SPKI PEM, Ed25519; a private key is refused; must not be an authority verification key |
| `…_TIMEOUT_MS` | 1 … 60 000 (default 5 000) |
| `…_MAX_ATTEMPTS` | 1, 2 or 3 (default 2) |
| `…_PROBE_INTERVAL_MS` | 0 … 60 000 (default 5 000) |

Public configuration carries the mode, the witness origin, id and bounds, and
`credentialConfigured` — never the credential.

### 2.16 Performance

Witness interactions, bounded and documented: startup (identity; per store a
read, a genesis enrollment for a new store, a finalize to complete a crash);
each authority transition (one prepare, one finalize); the rate-bounded
health probe. Ordinary reads — including every grant exercise — make none.

## 3. The reference witness

`scripts/run-reference-authority-state-witness.mjs` — a separate process,
loopback only, its own SQLite database, its own Ed25519 receipt key (generated
on first run, public half written to `<key>.pub` for the operator to pin), a
bearer credential compared in constant time, request bodies capped at 16 KiB,
responses at 16 KiB on the client, fixed paths, strict parsing, `503` on an
internal failure, counts-only diagnostics. It is **not** an HSM, a cloud
immutable ledger, a trusted timestamping authority, a blockchain or a consensus
system. Its security claim holds **only** while its database lives outside
the authority stores' restore domain.

## 4. What this closes, and what it does not

**Closes (within scope):** a restored earlier authentic state of the
bounded-grant, discharge or approval store — whole-file or row-level — is
refused before any authority is handed to the runtime (AA-003, GS-002), and
the equivalent residuals of CORE-04 and CORE-05. Same-sequence forks, store /
kind / organization substitution, unenrolled stores, the prepare/commit crash
window and concurrent successors are all refused.

**Does not claim** (separate trust boundaries, recorded as residuals):

| Residual | Why it is outside |
|---|---|
| The witness itself rolled back together with the authority store to the same earlier moment | the witness's trust assumption; indistinguishable by design — **authority databases and witness state must never be restored as one snapshot domain** |
| The witness rolled back alone | detected only as far as the local store is *ahead* (refused as unanchored); a witness reset to unbound is refused as unbound |
| Deployment configuration rewritten (witness endpoint, pinned key, credential) | AA-002 — configuration is a trust root |
| A malicious Host process | it holds the witness credential and can advance, prepare or (not) finalize at will |
| A trusted operator enrolling stale state, or first enrollment of an already-rolled-back store | the ceremony's attestation is the baseline |
| A holder of the witness credential | can deny service, and can advance slots arbitrarily (making the Host refuse); cannot make a stale local state current |
| Signer-independent revocation | AA-004 — still open; revocation now also needs the witness |
| Rollback of the Kernel Authority store | not an authenticated store: its event log is digest-chained but unsigned, so a database-level writer can already rewrite it (its pre-CORE-07 integrity boundary). There is no signed head to anchor; CORE-07 anchors only the three signed stores. The FRONTERA-PROD-01 storage-neutral provider contract does not change this |

PROD-02 owns safe backup / restore across the growing store set; CORE-07 does
not make arbitrary infrastructure snapshots safe.

## 5. Compatibility

No authority signature bytes, signing domains, canonical formats, SQLite
schemas or schema versions changed (grant, revocation, revocation-state,
discharge-state and approval-state signatures are byte-identical; CORE-01 /
02 / 04 / 05 suites pass unchanged). Software and external custody both work
with freshness; the signer is not the witness. The API surface stays at 36
endpoints. The FRONTERA-PROD-01 storage-neutral Kernel Authority provider
contract (on `main` before this change) is independent of CORE-07: CORE-07
neither reads its provider vocabulary nor anchors that store; durability here
is decided by the three signed stores' own brands (`durable-authenticated`)
and the persistence provider that composes them, and the secure Host's
`kernelAuthority` and `authorityFreshness` posture checks stay separate. Embedders that configure no witness see no behaviour change except
the two strengthened in-process witnesses (now also refusing a different
state at the same sequence under a running process).

## 6. Evidence

`src/enterprise/__tests__/authority-state-freshness-grants.test.ts` (G1–G12,
C1–C8, E1–E6 against real stores and a loopback witness),
`authority-state-freshness-obligations-approvals.test.ts` (O1–O8, P1–P9),
`authority-state-freshness-protocol.test.ts` (canonical checkpoint, strict
parsing, compare-and-advance, A1–A8 — including forged read receipts after the
handshake and authentic receipts that do not hold the asked checkpoint —
replay, retry taxonomy, transport bounds, configuration), the concurrent-writer
probe cases R1–R5 in the grants suite (a legitimate transition by another
process between the reads is neither a fork nor a rollback, and never poisons
the session; a real fork and a real older snapshot under a running process
stay fatal), `authority-state-freshness-host.test.ts` (the exercise-time
guarantee through `bootEnterpriseHost()` with a **separate-process** witness:
adapter calls unchanged after the restored snapshot; the refusal is
`AUTHORITY_FRESHNESS_ROLLBACK_DETECTED`; the no-witness embedding still believes
the old state; outage semantics; running-rollback unhealthy; the enrollment
ceremony), `authority-state-freshness-structure.test.ts`, and the three
inverted residual tests in `revocation-state-integrity.test.ts`,
`obligation-discharge-authenticity.test.ts` and `approval-authenticity.test.ts`.
The non-vacuity pass (M1–M18) is recorded in the Master Plan's CORE-07 entry.
