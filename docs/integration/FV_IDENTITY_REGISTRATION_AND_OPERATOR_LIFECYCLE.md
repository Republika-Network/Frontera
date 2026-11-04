# FV-P4C-2B3C-2A — FV identity registration and operator lifecycle

**Status: internal and non-operational. Not production-ready. Production activation: NO-GO.**
- Nothing in the Host, its scripts, its deployment, the dedicated executor or its supervisor invokes the
  registration ceremony (structure tests pin this). The production executor entry still composes nothing.
- No production issuer of a registration capability exists; issuance in this repository is test-only.
- Bootstrap execution stays disabled: there is no trusted status source (B6).

**Split (§15 of the increment prompt).** **B3C-2A1** implemented durable registration authority, genesis, the
store-id pin and its verification by the executor. **B3C-2A2A** (the first FV administrator) is implemented in
§15. **B3C-2A2B** (FV operators under the administrator's authority, and the Host/FV administrative boundary) is
implemented in §16. **B3C-2A3A** (revoking an FV operator credential under the administrator's authority) is
implemented in §17. **B3C-2A3B** (governance recovery, administrator revocation, interrupted enrolment) remains
**design only** (§18).

## 1. Verified inventory (main `64b3ec7c`, PR #260 merged)

| Contract | What exists | Limitation for FV registration |
|---|---|---|
| AUTH-03 store (`human-identity/sqlite-human-identity-store.ts`) | Signed, hash-chained head; `create: true` makes a genesis only in an empty file; `exclusive` (B3C-3): exclusive lock, fenced writes, guarded close, `storeId` pin checked on open (on the `create` path after the genesis commit, which the ceremony runs only once the witness holds S's genesis); FV domain only with `exclusive`; an exclusive owner never enrols. | Any trusted in-process caller could perform an FV genesis; nothing recorded who authorized it. |
| AUTH-02/03 service (`human-identity/service.ts`) | Principals, admin-authorized single-use enrolment tokens, WebAuthn registration with proof of possession, recognition, admin and owner revocation, decision challenges. | **Administration is the Host's**: `identityAdministratorFor` accepts only a CTRL-02 `organization-administrator` of the Host's operator plane. Reused for FV, every Host administrator would administer FV operators. Not reused (§10). |
| CORE-07 (`authority-state-freshness/`) | Per-(kind, organization) witness slots; `fv-bootstrap-identity-state` is the FV domain; signed receipts bound to a fresh challenge and the binding; genesis enrolled **before** the local genesis, adopted only if the witness holds exactly that store's genesis; a slot binds once, never rebinds; the witness refuses a store id already bound in the other identity domain. | `genesisStoreId` adopts **whichever** store id the slot holds at genesis: it cannot tell an authorized genesis from another one. |
| G-02A execution capability (`execution-capability/`) | A closed, canonical, signed single-use capability; a standalone verifier (pinned issuers and keys, exact audience, organization, trust domain, ≤ 60 s window, action, resource, and an action binding the executor **recomputes**); a durable consumption ledger (one row per capability and per issuer execution, committed before any side effect, forward-only). | The ledger is not rollback-anchored. No FV action or binding format existed; no production issuance path for it (G-02B issues only from a governed grant). |
| B3C-3/FV-EXEC-LOCK-01 (`executor-exclusivity.ts`) | `checkProtectedFile` (owner-only, canonical, no links), `confirmExclusivelyHeld` (this process's fdinfo POSIX lock view), `exclusiveCloser`, `heldByAnotherProcess`. | — |
| Composition (`protected-host-composition.ts`) | Opens its own identity store exclusively, pinned by `identity.storeId`, in the FV domain, never creating or enrolling. | The pin was trusted configuration only: nothing proved that the pinned store came from an authorized registration. |
| Supervisor IPC (`dedicated-executor-protocol.ts`) | `status` and `stop` only. | Unchanged; no registration crosses it. |
| AUTH-02/AUTH-04A/CORE-05 | Host administration and approval channels. | Unchanged. |
| PROD-02 (`executor-persistence-contract.ts`) | Declares executor-owned stores, executor-mediated or cold snapshots (deferred to B3C-2). | Unchanged here; the registration record and ledger need a backup rule in B3C-2 (§13). |

**Reusable one-time primitive found:** G-02A. The registration authority is a G-02A capability with a new
action and binding format, verified by G-02A's own verifier and consumed in G-02A's own ledger. No parallel
authorization system was written.

## 2. Threat model

| Threat | Trust boundary | Durable evidence | Refusal | Recovery | Tests |
|---|---|---|---|---|---|
| Unauthenticated caller, Host login token, operator credential, configuration flag | Pinned registration issuer keys | — | `CAPABILITY_REJECTED` (`CAPABILITY_MALFORMED`, `REQUEST_INVALID`) | — | capability matrix |
| Reused / replayed capability | G-02A ledger; witness slot | Ledger row; record intent | `ALREADY_REGISTERED`, `REGISTRATION_PENDING`, `CAPABILITY_NOT_CLAIMED: CAPABILITY_CONSUMED`; a full local wipe: `WITNESS_ALREADY_BOUND` | — | "never a second genesis", crash matrix |
| Expired, not-yet-valid, over-long | Verifier clock (secondary) | — | `CAPABILITY_EXPIRED` / `NOT_YET_VALID` / `LIFETIME_INVALID` | — | capability matrix |
| Another organization, witness (id or key), domain, deployment, store, path, policy, signing key, operation, audience, trust domain | Recomputed action binding | — | `ACTION_BINDING_MISMATCH`, `ORGANIZATION_MISMATCH`, `ACTION_MISMATCH`, … | — | capability matrix |
| Operator alters the parameters beside the capability | Recomputed binding | — | `ACTION_BINDING_MISMATCH` | — | capability matrix |
| Unknown, untrusted or rotated-out issuer key | Verifier pins | — | `ISSUER_UNTRUSTED`, `SIGNATURE_INVALID`, `ISSUER_KEY_MISMATCH` | — | capability matrix |
| Host store, copy, replacement, symlink, hard link at the path | Filesystem policy; `O_EXCL` | — | `STORE_PATH_OCCUPIED`, `PATH_REFUSED: LINKED` | — | "no existing store is ever claimed" |
| Another FV store (another deployment, a test-only genesis) | Witness FV slot | Witness binding | `WITNESS_ALREADY_BOUND` (before consumption) or, racing, `quarantined: WITNESS_BOUND_TO_ANOTHER_STORE` | Never adopted | race tests |
| The Host store's id preselected as the FV id | Witness cross-domain rule (+ registrar pre-check) | — | `STORE_ID_IN_ANOTHER_DOMAIN`; the witness would refuse the genesis (`WITNESS_REFUSED_STORE_ID`) | — | substitution test |
| Concurrent ceremonies | Record exclusive lock; ledger `IMMEDIATE` claim; witness compare-and-set | — | `REGISTRAR_BUSY` | — | concurrency tests |
| Crash, lost answer, unavailable witness | Record states | Each state written before the next external step | `pending` | Resume capability, from evidence | crash matrix |
| Ambiguous / inconsistent evidence at recovery | Record × witness × file | — | `quarantined` (terminal) | None automatic (B3C-2) | quarantine tests |
| Corrupted or forged record | Triggers, validation, issuer signature over the binding | — | `RECORD_CORRUPT`; executor `AUTHORIZATION_UNVERIFIED` | — | corruption and forgery tests |
| Registration while an executor holds the store | POSIX lock | — | `pending: STORE_HELD` | Resume later | lock test |
| Substituted store under a running executor configuration | Record file identity; witness binding; pin | — | `IDENTITY_UNREGISTERED: STORE_FILE_MISMATCH`, `STORE_MISMATCH`, `WITNESS_MISMATCH` | — | executor gate tests |
| Rolled-back store / old snapshot with current witness | CORE-07 freshness at open | Witness head | `IDENTITY_REFUSED` (rollback) | — | B3C-3 / CORE-07 suites |
| Operator lifecycle threats (§3 of the prompt) | — | — | **Not implemented** (B3C-2A2/A3) | — | — |

## 3. Selected architecture

| | A. Offline registration ceremony (**selected**) | B. Supervisor-mediated | C. Dedicated registration service |
|---|---|---|---|
| Authority boundary | A separately invoked process, run while no executor holds the store | Adds a privileged operation to, or beside, the status/stop channel | A long-running process with its own secrets |
| B3C-1 status/stop-only IPC | Unchanged | Weakened, or a second authenticated channel needed | Unchanged, but a new channel to it |
| B3C-3 one owner per store | The ceremony creates the store, closes it; the executor later owns it | Two owners in two processes | Two owners |
| Network surface | None (only the deployment's witness, as a client) | None new, but privileged | A new endpoint |
| Secrets moved | None: the store's signer stays in the deployment's custody, the capability is verified, never signed | Through IPC | Into the service |
| Crash recovery | Durable record states; resume from evidence | Across a channel | Across a channel |
| Testable locally | Yes (real witness, real processes) | Partly | Partly |

**Why A.** It adds no channel to the executor, no endpoint and no secret custody, and the store's first owner is
the ceremony itself, under the same exclusive-lock rules the executor uses. Registration happens before the
executor ever opens the store; startup never creates anything (structure test).

## 4. Registration capability (G-02A, profile `frontera.fv-identity-registration-binding.v1`)

- **Action:** `frontera.fv-bootstrap-identity.register` (and `…resume-registration`, §6).
- **Resource:** `fv-bootstrap-identity:<organizationId>`.
- **Audience, trust domain, organization:** the registrar's own G-02A context, compared exactly.
- **Execution id:** the registration id (`fvreg-<32 hex>`), so a second capability for one registration is
  refused by the ledger (`EXECUTION_CONSUMED`).
- **Action binding**, recomputed by the registrar from its own trusted configuration and the two values the
  issuer chose:

| Field | Source at verification |
|---|---|
| `operation` | `register` or `resume` |
| `registrationId`, `storeId` | Chosen by the issuer, passed beside the capability; must recompute |
| `organizationId`, `deploymentId` | Registrar configuration |
| `stateKind` | The constant `fv-bootstrap-identity-state` |
| `witnessId`, `witnessKeyDigest` | The pinned witness id and `sha256` of its pinned SPKI key |
| `storePath`, `storePolicy` | The resolved store path; `frontera.fv-identity-store-policy.v1` |
| `authenticityKeyId` | The deployment signer's active key id |

- **Window:** G-02A's (≤ 60 s, ≤ 5 s skew). It bounds when a capability can be **consumed**; it is not the
  replay defence. Clock rollback: a stepped-back clock could revive an *unconsumed* expired capability, never
  a consumed one (the ledger), and never a second genesis (the witness).
- **Issuer and custody:** a pinned G-02A issuer. A production issuer would sign through G-02B's in-custody
  rule from a governed grant; **no FV registration action is registered there, and nothing in this
  repository issues one outside tests** (`__tests__/fv-identity-registration-issuer-fixture.ts`,
  per-process keys). A self-issued development key is trusted only by the tests that pin it.
- **Verifier unavailable:** there is no fallback; an empty issuer set is a configuration error.

## 5. One-time consumption

1. **The ledger.** G-02A's ledger (pinned to the registrar's audience) consumes the capability in one
   `IMMEDIATE`, `synchronous = FULL` transaction, **before** the intent is recorded and before the witness is
   asked anything. A replay is `CAPABILITY_CONSUMED`.
2. **The record.** The consumed capability is kept verbatim (canonical text and CORE-02 envelope).
3. **The witness.** The FV slot of the organization binds once and never rebinds. Even with the record and the
   ledger deleted or rolled back, no second store is ever anchored for the organization
   (test: "a full local wipe").

A crash between the claim and the intent spends the capability with nothing contacted (the intent precedes
every witness call); the next ceremony on the same record marks that orphaned claim `failed`, but only a claim
that record proves it made (§14.2).

## 6. Genesis sequence and evidence

| Step | Durable before the next step | Externally visible effect |
|---|---|---|
| 1. Verify the capability (pins, binding) | — | — |
| 2. Lock the record (`locking_mode = EXCLUSIVE`, `BEGIN EXCLUSIVE`) | — | — |
| 3. Refuse if a registration exists, the store path is occupied, the witness FV slot is bound, or the Host slot holds the store id | — | — |
| 4. Consume the capability | Ledger row | — |
| 5. **`intent-recorded`**: every binding field, the capability | Record | — |
| 6. Witness: read the FV slot; if unbound, `enroll('genesis', S at sequence 0)`; the answer (or, after a loss, a later read) must show exactly S's genesis | — | Witness binds S |
| 7. **`witness-anchored`**: the genesis digest | Record | — |
| 8. Reserve the file: `open(O_CREAT|O_EXCL, 0600)`, `fsync` file and directory | File | Empty file |
| 9. Record its identity (`dev:ino:birthtime`) | Record | — |
| 10. Open the AUTH-03 store with `create`, `exclusive` (fenced by the record's and the store's locks and the reserved identity), the FV domain, pinned to S: its genesis adopts exactly the witnessed one | Store genesis | — |
| 11. **`store-created`** | Record | — |
| 12. Readback: reopen (no create) under freshness, head = S's genesis, same file, still held; read the witness again | — | — |
| 13. **`registered`** | Record | — |
| 14. Return non-secret evidence (ids, digests, file identity, capability id) | — | — |

Never one atomic transaction across SQLite and the witness. Every refusal or ambiguity leaves the record
where it was (`pending`) or quarantines it.

## 7. Store-id pin: location and trust

| Holder | What it holds | Trust |
|---|---|---|
| **CORE-07 witness, FV slot** | `(fv-bootstrap-identity-state, org) → S`, bound once, never rebound, signed receipts | **The authoritative pin.** Outside the stores' restore domain (CORE-07's deployment assumption). |
| The registration capability (in the record) | The issuer's signature over the binding naming S, the path, the witness, the key | Unforgeable without the issuer key |
| The registration record | Ceremony evidence and state; the reserved file identity | Evidence, not authority: a raw writer can forge rows but not the signature, nor rebind the witness |
| The composition's `identity.storeId` | The expected S | Trusted configuration |
| The AUTH-03 store | Its own `storeId`, signed by the deployment key | Checked by the pin |

**The executor's verification (`verifyFvIdentityRegistration`, opt-in `registration` composition option).**
Before the composition opens anything of its own, it requires a `registered` record of exactly this
organization, FV domain, store id, path and witness **id** (the record's signed witness key digest, deployment and signing key are not compared with the executor's own configuration; CORE-07 confirms the binding at open), on the very file the ceremony reserved, whose stored
capability verifies under a pinned issuer key over exactly the binding the record's own fields recompute to.
Opening the store under freshness then confirms that the witness binds S at a head the store holds, and the
held file is checked again against the reserved identity. With `registration` absent (every existing test),
the composition behaves as before and reports `identityRegistration: 'unverified'`; making it mandatory is an
activation requirement (§13).

**Not proved:** that the file system has not reused an inode number with the same birth time (file identity is
defence in depth; the witness and the signed chain are the cryptographic checks); anything against a writer
with the deployment's signing key or the issuer key; coordinated restoration of the witness (FV-P4D).

## 8. Registration state machine and crash matrix

States (durable, forward-only, enforced by triggers): `intent-recorded` → `witness-anchored` →
`store-created` → `registered`; any of the first three → `quarantined` (terminal). `NOT_REGISTERED` is the
absence of a record; `REFUSED` is a result, never a state.

| # | Case | Behaviour | Test |
|---|---|---|---|
| 1 | Before capability validation | Nothing exists | capability matrix ("nothing was created anywhere") |
| 2 | After validation, before durable intent (SIGKILL after the claim) | Capability spent; no record, witness unbound, no file; a new capability registers; the orphan is `failed` | "killed after the capability was consumed" |
| 3 | After intent, before store creation | `intent-recorded`; resume registers | SIGKILL at `intent-recorded` |
| 4 | During store creation | Empty reserved file, or genesis committed: resume continues | SIGKILL at `store-file-reserved`, `store-genesis-committed`; the unrecorded empty file |
| 5 | After store creation, before witness enrolment | Not reachable: the witness genesis precedes the file | — |
| 6 | Witness genesis committed, answer lost | `intent-recorded`; resume reads the slot, finds S's genesis, continues (never a second genesis) | SIGKILL at `enroll-sent` and `witness-genesis-answered` |
| 7 | Witness enrolment refused | Another store: `quarantined: WITNESS_BOUND_TO_ANOTHER_STORE`; cross-domain: `WITNESS_REFUSED_STORE_ID` | race test |
| 8 | Witness pending or unknown | `pending: WITNESS_UNAVAILABLE`, record unchanged | failed-enroll and outage tests |
| 9 | After witness genesis, before the pin is recorded | `intent-recorded` with S bound: as 6 | SIGKILL at `witness-genesis-answered` |
| 10 | After pin persistence, before completion | `witness-anchored` / `store-created`; resume completes | SIGKILL at `witness-anchored`, `store-created` |
| 11 | After success, before the answer | `registered`; readable; resume reports without consuming | SIGKILL at `registered` |
| 12 | Concurrent registration of one organization | One registers; the other `REGISTRAR_BUSY`, `ALREADY_REGISTERED`, `WITNESS_ALREADY_BOUND` or quarantined | two concurrency tests |
| 13 | Conflicting capability against an existing registration | `ALREADY_REGISTERED` / `REGISTRATION_PENDING` / `REGISTRATION_QUARANTINED` | several |
| 14 | Rolled-back local store | `store-created` with the file gone or replaced: `quarantined: STORE_FILE_REPLACED`; a registered store rolled back: refused at open by CORE-07 | quarantine tests; B3C-3/CORE-07 suites |
| 15 | Foreign witness | `CONFIGURATION_MISMATCH` (resume); `WITNESS_MISMATCH` (executor) | resume and gate tests |
| 16 | Corrupted registration evidence | `RECORD_CORRUPT`, never repaired | corruption test |
| 17 | Replay after complete registration | `ALREADY_REGISTERED` | replay test |
| 18 | Replay during pending recovery | Register capability: `REGISTRATION_PENDING`; register presented as resume: `ACTION_MISMATCH`; a spent resume: `CAPABILITY_CONSUMED` | crash matrix |
| 19 | Registration while an executor holds the store | `pending: STORE_HELD` | lock test |
| 20 | SIGKILL at each materially distinct phase | All of the above, by real `SIGKILL` from inside the child at the durable step (never an injected exception) | crash matrix |

**Recovery rules.** A lost answer is never a failure, and an existing witness genesis is never by itself
authority to continue: continuing needs a **resume** capability bound to this registration's every intent
field, consumed once, under the same configuration (another witness, path, key or deployment is refused). The
evidence is then reconciled: intent, capability, witness slot, file identity, store head. Disagreement is
quarantine: no re-enrolment, reset, rebind, replacement or adoption. The only file ever taken over is the empty
file the ceremony's own crash can leave between `O_EXCL` and recording it.

## 9. Executor integration (non-operational)

| Condition | Result |
|---|---|
| No record, record pending, quarantined | `IDENTITY_UNREGISTERED` (`NOT_REGISTERED`, `REGISTRATION_PENDING`, `REGISTRATION_QUARANTINED`) |
| Witness not composed | `OPTIONS_INVALID` |
| Witness uncertain at open | `IDENTITY_REFUSED` (CORE-07 refuses) |
| Store id, path or witness mismatch; issuer not pinned; forged record | `IDENTITY_UNREGISTERED` (`STORE_MISMATCH`, `WITNESS_MISMATCH`, `AUTHORIZATION_UNVERIFIED`) |
| A different file at the path | `IDENTITY_UNREGISTERED: STORE_FILE_MISMATCH`, and re-checked after the lock is held |
| Identity lock unavailable | `EXECUTOR_HELD` (unchanged) |
| Credentials, revocation currentness | Not implemented (B3C-2A2/A3) |
| Valid registration | Composes, `identityRegistration: 'verified'`, **`bootstrapExecution: 'disabled'`**, `bootstrap()` → `BOOTSTRAP_DISABLED` |

Unchanged: fdinfo lock verification, fail-stop, the guarded close, the status/stop IPC, the production entry
(`compose: undefined`).

## 10. B3C-2A2 — FV operator enrolment (original design; implemented as 2A2A, §15, and 2A2B, §16)

- **First administrator.** Authorized by a separate G-02A capability,
  `frontera.fv-bootstrap-identity.enroll-first-administrator`, from the **registration** issuer (independent of
  the store), bound to the registration id, store id, witness, the candidate's operator id and the store's head
  at sequence 0 (so it is valid only while the store holds no principal). Run by the same offline ceremony,
  which holds the store exclusively. The candidate proves possession through AUTH-02's WebAuthn registration;
  the principal, enrolment and credential rows are appended under CORE-07 freshness. No circularity: the
  issuer authorizes the first administrator; the administrator never authorizes itself. The registration
  caller does not become an administrator.
- **Further operators.** An FV administrator's AUTH-03 decision (a new FV administration challenge domain,
  passkey assertion of an active FV administrator), never `identityAdministratorFor` (the Host's operator plane)
  and never a Host credential. Requires an AUTH-03 change, reviewed on its own.
- **Binding.** Exact organization and store; another organization's or the Host's credential is unknown to the
  FV store; a duplicate is idempotent, a conflict refused.

## 11. B3C-2A3 — revocation and governance recovery (original design; operator credentials implemented as 2A3A, §17; recovery: design only, §18)

- Revocation by an FV administrator's decision; exact credential and store; appended under CORE-07 (a
  prepared-but-unconfirmed revocation is never reported as done; `pending-recovery` refuses every read, so it
  fails closed).
- **Last administrator:** refused. Removing the last one needs a governance-recovery capability from the
  registration issuer.
- Host revocation does not propagate to FV, nor the reverse; Kernel-Authority standing (checked on every
  bootstrap) is the shared control. Revocation affects future authentication and decisions only, never
  committed signed evidence.
- Concurrency cases (revocation with a challenge, an approval, an enrolment; repeats; lost answers; rollback)
  are to be tested there.

## 12. Results

**Tests.**
- `tests/fv-p4c2b3c2a-identity-registration.e2e.test.mjs`: 43 tests, including four from the publication audit and two from the publication review. They use a real reference witness, real AUTH-03 stores, the real G-02A verifier and ledger, and child processes killed by `SIGKILL` at each durable step.
- `src/enterprise/__tests__/fv-p4c2b3c2a-identity-registration-structure.test.ts`: 7 tests.
- Two existing import-isolation pins gained an exact, commented exception for `identity-registration.ts`, with new assertions that it composes no identity service, decision channel or settlement capability:
  - `fv-p4c2b2-structure` 50/51/52;
  - `auth03-…-structure`.

  No assertion was removed.

**Targeted mutants:** 18 of 18 killed at implementation, plus 2 of 2 for the publication-review fixes (removing the authenticity probe; touching a WAL database at the record path). Each was applied to the compiled module in a separate copy and run against the targeted tests only, and every file was restored and hash-verified. The mutants cover:
- removing the capability signature check, the organization scope check, the execution scope check, and one-time consumption (register and resume);
- removing the witness identity check (resume and executor), the store-id pin, the existing-store refusal and the foreign-file refusal;
- removing the genesis readback and the cross-domain check;
- treating a pending registration as complete;
- treating a lost acknowledgment as failure, and a lost acknowledgment's genesis as a disagreement;
- treating a quarantined registration as ready;
- removing resume authorization and the executor's signature check.

**Independent review** (a read-only AI agent of the same model family; **not a human review**). It found no authority bypass: no capability replay, no unauthorized first administrator, no double genesis, no adoption, no path to FV execution. It also traced reachability: the static import graph from every package export, the executor entry, the supervisor and every script and deploy file never reaches the ceremony.

| Finding | Severity | Resolution |
|---|---|---|
| A witness failure that is not evidence (401, a proxy's 404, a garbage or unauthentic answer) during store creation or readback was quarantined. The slot is bound by then, so the organization was locked out for good. Reproduced. | Medium | **Fixed.** Only evidence codes quarantine (rollback, fork, pending recovery, binding mismatch, unbound, already enrolled); everything else is `pending`. Six regression tests; three of them fail on the pre-fix build. |
| A zero-length file the same user placed at the reserved path is taken over as the ceremony's own crash leftover. | Low | Accepted and documented: the same user is outside the trust boundary and could write the file anyway. The claim was corrected (§8, module comment). |
| The executor gate trusts the record's unsigned state columns. It does not compare the deployment, witness key or signing key with its own configuration. | Info | Accepted: the witness binding and the file-identity re-check after the lock stop any store other than S. Recorded below. |
| The policy text said "owner-only directory", but the check is "not writable by group or others". | Info | Wording fixed. |
| The gate is opt-in, and in-process callers can still perform an FV genesis directly. | Info | Already an activation requirement (§13). |
| An empty file placed at the record path gives a permanent `RECORD_CORRUPT`. | Info | Accepted: a same-user self-denial of service. |

**Publication review of PR #262** (a fresh read-only AI agent, not human). It found no Critical, High or Medium issue. Its 13 priority checks came back clean.

| Finding | Severity | Resolution |
|---|---|---|
| A registrar whose verifier does not trust the signer's key passed every check up to the genesis. It was then quarantined (`STORE_NOT_GENESIS`) with the slot bound: a misconfiguration locked the organization out. Reproduced. | Low | **Fixed.** Register and resume sign and verify this registration's genesis with the configured signer and verifier before anything is consumed. A failure is `AUTHENTICITY_UNVERIFIED`. One regression test; its mutant is killed. |
| A record path naming another owner's WAL database was checkpointed and converted to a rollback journal before being refused. Reproduced. | Low | **Fixed.** A WAL database (by header, or by a `-wal` file) is refused before SQLite opens it. An existing file's structure is verified before any pragma. One regression test checks the file is byte-for-byte unchanged; its mutant is killed. |
| The executor compares only the witness id, not the signed witness key digest, deployment or signing key. | Low | Accepted as defence in depth (CORE-07 confirms the binding at open). The §7 wording was narrowed. |
| Resume and register report `registered` from the record alone. A crash between creating the record file and its schema leaves a permanently corrupt record. `registrationAuthorized` skips the rule that a key id names one issuer. A rejecting observer promise goes unhandled. The §1 wording on the store pin was too strong. | Info | Status-only, liveness-only, or misconfiguration-only. Documented; the §1 wording was corrected. |

**Publication audit (B3C-2A1-REL): what the record's fields are worth.** This audit plays a raw same-user
writer. That writer drops the triggers, rewrites rows and re-creates the triggers, and can also replace,
copy or restore the record file.

| Field group | Protection | What it can affect |
|---|---|---|
| Intent fields that make up the binding: organization, FV domain, deployment, witness id, witness key digest, store id, path, policy, signing key id; plus registration id, capability id and issuer, audience, trust domain | **Issuer signature** over the stored capability. The binding digest is recomputed from these fields, at the gate and on resume. | Nothing. Any rewrite fails verification (`AUTHORIZATION_UNVERIFIED`). |
| `state` and the set-once progress fields (`store_file_identity`, the step timestamps) | SQLite transactions, triggers, the exclusive lock, and a check that state and progress fields agree on read. **No signature.** | Liveness only, unless the store the issuer authorized already exists and the witness holds its genesis (below). |
| `store_file_identity` | Re-checked against the locked file after it opens | Defence in depth. The **store-id pin, the store's signature and the witness** decide which store is admitted. |
| `genesis_digest` and the timestamps | None beyond the triggers | Advisory. The gate doesn't read them. |

Outcomes, run on the final build (pinned by four e2e tests):

| Tampering | Outcome |
|---|---|
| A record still at `intent-recorded` (witness never asked) promoted to `registered` over a store put at the path | Refused (`RECORD_CORRUPT`). |
| `registered` moved back, or a `registered` record with its file identity removed | Refused (`RECORD_CORRUPT`). |
| A capability reference, the capability text or a binding field changed | Refused (`AUTHORIZATION_UNVERIFIED`). |
| Another organization's record, or the same organization's record from another witness, copied in | Refused (`RECORD_CORRUPT` / `STORE_MISMATCH`). |
| An older, pending copy of the record restored after completion | Refused (`REGISTRATION_PENDING`). Registering again is refused; the witness still holds only S. |
| An in-progress record rewritten before resume, including a skipped witness step | Quarantined. The witness is never contacted. |
| The file identity rewritten to another FV store or a Host store at the path | Refused by the pin (`IDENTITY_REFUSED`). |
| The file identity rewritten to a byte-identical copy of S | **Admitted.** It is the authorized store at the head the witness holds. |
| A crashed registration at `store-created` (S exists, the witness holds S's genesis) promoted to `registered` | **Admitted without a resume capability** (trust dependency below). |

**Trust dependency (Low, accepted, documented).** The state column is not authority.

- A same-user writer can finish a crashed but authorized registration without a resume capability:
  - from `store-created`, by promoting the state;
  - from `witness-anchored`, also with the deployment's signing key, by making S's deterministic genesis
    as an exclusive FV owner.
- This only ever admits the store the issuer signed for, at the genesis the witness already holds, for the
  same organization. It admits no other store, no second genesis, and no principal. Bootstrap stays
  disabled.
- The resume capability limits what the ceremony itself does. It doesn't protect against a writer that
  already has the deployment's files and keys.
- The same writer, holding the witness credential, can also make an unauthorized FV genesis under a random
  id before the ceremony reaches the witness. That takes the organization's slot: a denial of service that
  the gate and every later registration refuse. It is never admitted.
- Excluding that writer is a deployment requirement (process and filesystem isolation, §13). No local
  evidence can do it.

## 13. Deployment prerequisites and residual limitations

**Before any activation (each is a blocker):**
- a production registration issuer (G-02B in custody, from a governed grant), its key pinned out of band;
- the `registration` composition option made mandatory for the dedicated executor;
- B3C-2A3B (governance recovery, administrator revocation and replacement, the interrupted-enrolment escape; §18);
- the executor requiring an enrolled FV administrator and FV operators, and anything that trusts the operator role
  using `verifyFvOperatorRoles` (§16; nothing requires either yet);
- B3C-2 backup and restore, covering the registration record and ledger (evidence and replay protection;
  the witness stays the authority) beside the FV stores;
- a witness running the CORE-07-FV-WITNESS version, outside the stores' restore domain;
- operational process and filesystem isolation; B6; FV-P4D.

**Residual limitations:**
- The consumption ledger and the record are as trustworthy as their host: a same-user writer can forget a
  consumption or forge record rows. Neither yields a second store (the witness), and a record whose intent
  fields were rewritten fails the issuer-signature check in both the executor's verification and `resume`
  (`RECORD_CORRUPT: AUTHORIZATION_UNVERIFIED`). Forgetting is not forging: a deleted record and ledger let a
  new capability try again, and the witness refuses it.
- Inode reuse with an equal birth time would defeat the file-identity check; the witness and the store
  signature still hold.
- The executor's gate trusts the record's unsigned state columns. It compares only the witness id, not the
  deployment, the witness key or the signing key, with its own configuration. The witness binding and the
  locked file's identity are what exclude another store. A same-user writer can therefore promote a crashed,
  authorized registration whose store exists without a resume capability (§12, publication audit). This
  admits only S.
- An empty file at the reserved store path is taken over as the ceremony's own crash leftover, even if the same
  user put it there. An empty file at the record path blocks every registration (`RECORD_CORRUPT`).
- The witness trusts the same deployment as both identity domains; coordinated restoration is FV-P4D.
- The executor gate is opt-in until activation; without it the composition opens a pinned store whose
  registration it has not verified (as before this increment).
- AI review is not human security approval.

## 14. HF01: witness evidence classification and ledger claim isolation (post-merge, PR #262)

The final Codex review of PR #262 reported two P2 findings, both after merge. Both were reproduced on the
merged code (`2f91c287`) and fixed in `identity-registration.ts` alone. CORE-07, G-02A and every other
consumer are unchanged.

### 14.1 Finding 1: an authentic receipt about another slot quarantined a healthy registration

**Root cause.** CORE-07 raises one code, `AUTHORITY_FRESHNESS_BINDING_MISMATCH`, for two different things:
- **About this slot.** The witness's verified state for *this* slot binds a different store (`session.ts`
  `reconcile`), or the local store changed identity (three local sites).
- **About another slot.** The pinned witness signed a receipt, with this request's challenge, about
  *another* organization, state kind or namespace (`witness-client.ts`). That receipt is authentic but has
  nothing to say about this registration.

The registrar listed the code among its evidence codes, so a misrouted read during store creation or the
readback permanently quarantined a registration whose real slot still held its genesis.

**Reproduction (merged code).** A shares a witness with B, whose slot is bound. A's FV-slot reads were answered,
from `store-file-reserved` or `store-genesis-committed`, with the witness's own signed receipt about:
- B's slot;
- A's Host slot;
- a namespaced slot.

All six runs ended `quarantined` (`STORE_NOT_GENESIS`), with resume refused for good. A's real FV slot still held
`(S, sequence 0)`. Answers signed by another key, or replayed for another challenge, were already `pending`
(`WITNESS_UNAUTHENTIC`).

**Fix.** A `BINDING_MISMATCH` is now treated as evidence only after a confirming read. The confirming read is
of this registration's own slot, and verified as bound to exactly that slot.

| Confirming read | Classification | Outcome |
|---|---|---|
| Unreadable: any refusal, including another misrouted answer | B: unverifiable or misrouted | `pending` (`WITNESS_UNAVAILABLE`) |
| This slot still holds S's genesis | B: the mismatch was not about this slot (a misrouted receipt, or one of the local "store changed identity while opening" sites, which need the exclusively held file tampered with mid-open) | `pending`. Resume re-checks the file identity, the store pin (which quarantines a substituted store as `STORE_NOT_GENESIS` before the witness is asked), the genesis readback and the witness. |
| This slot binds another store, has advanced, or is unbound | A: authoritative contradiction | Quarantined (`WITNESS_BOUND_TO_ANOTHER_STORE` / `WITNESS_ADVANCED_UNEXPECTEDLY`) |

**Unchanged:**
- Rollback, fork, pending recovery, unbound and already-enrolled still quarantine. CORE-07 raises them only
  after verifying the receipt's binding against the request.
- Every other code stays `pending`.
- `pending` never completes, and never makes the executor ready (`REGISTRATION_PENDING`).
- Completion still needs a resume capability, the readback under freshness, and a verified read showing
  genesis (class C).

Authenticity of a receipt is not relevance to the slot that was asked about.

### 14.2 Finding 2: one registration settled another's ledger claim

**Root cause.** The orphan cleanup marked `failed` every `claimed` entry in the ledger that its own record
didn't name. A ledger is scoped by audience, not by organization or record. So any other registration on the
same ledger file, whether another organization's or another deployment's of the same organization, had its
in-flight claim, or its claim from just before a crash, marked `failed`. `failed` is terminal (the ledger only
moves forward), so it stayed wrong after that registration completed.

**Reproduction (merged code).** With A paused or killed right after recording its intent, B registered on the
shared ledger. A's claim became `failed`, A then completed, and its claim stayed `failed`.

This was **bookkeeping only**. Single use is the ledger's UNIQUE claim, which never reopens. No ceremony
decision reads a claim's state. The witness still enforces one genesis.

**Fix: ownership is proven, never inferred.**
- Before each claim, register and resume first check the ledger. A capability it already holds is refused
  (`CAPABILITY_CONSUMED`) with no intent written. Otherwise they append a `capability-claim-intent` event to
  their own record, under its exclusive lock, naming the capability id, execution id, binding digest and
  organization. A claim the ledger then refuses, or that throws (unknown outcome), appends
  `capability-claim-refused`, which fails closed: at worst one of this record's own orphans is left `claimed`.
- A claim is this record's orphan, and is marked `failed`, only when all of these hold:
  - the record logged that intent;
  - the record has no refusal for it;
  - no intent row, `intent-recorded` event or resume event names it;
  - the ledger still shows it `claimed` for the same organization, execution and binding.
- Holding the record's lock proves that none of this record's ceremonies is in flight.
- Left as they are:
  - other organizations' claims;
  - other deployments' claims (another binding means another capability, so no intent);
  - refused claims;
  - orphans in records written before HF01, which have no intent events.
- Every page of unresolved claims is examined, so other registrations' entries never push this record's
  orphans out of view.
- Settling now also runs before a resume's claim.
- A resume that ends `registered` or `quarantined` also settles the register claim its record's row holds.
  Before, a crash left that claim `claimed`. A refused or pending resume leaves it unsettled, because a later
  resume may still complete it.

**Allowed transitions (all by the owning record):**
- `claimed` → `failed`: an orphan, proven as above;
- `claimed` or `outcome-unknown` → `completed`, `failed` or `outcome-unknown`: the ceremony's own outcome.

Nothing else. In particular, nothing is ever deleted or reopened.

**Residual window (independent review, Low).** The ledger and the record are separate files, so the intent
and the claim aren't atomic, and the ownership rule can't be stronger than this. An intent is written only
for a capability the ledger didn't hold at that moment. Mis-settling a claim therefore needs all of these:
- another record that verifies the *same* capability, which is the same deployment, store path, witness and
  signing key under another record path (a misconfiguration);
- that record claiming it between this record's check and this record's claim;
- this record failing to record the refusal: it dies first, or the append itself fails. A claim that throws
  is recorded as refused too.

Only then may this record later settle the other record's claim `failed`. That is bookkeeping only: nothing
is reopened, consumed twice or created, and no ceremony decision reads the state.

### 14.3 Evidence

- **Tests:** `tests/fv-p4c2b3c2a1-hf01-witness-ledger-isolation.e2e.test.mjs` (16 tests), using real witnesses,
  stores, verifier and ledger, and real child processes paused or killed at durable steps. They cover:
  - each misrouting, from both steps, including a persistent misrouting during resume;
  - another key and a replayed answer;
  - an authoritative contradiction, using a witness of the same identity and key whose slot binds another
    store: quarantined;
  - each organization in flight while the other registers, in both orders;
  - the same organization's other deployment;
  - a crash after the intent;
  - a resume refused partway (an unsafe store file), which leaves the register claim unsettled until the
    completing resume;
  - both organizations orphaned, then retrying concurrently in separate processes;
  - a refused claim;
  - a cross-organization capability.

  On the merged code, 14 of the 16 fail. The two that pass (another key or a replayed answer; a cross-organization
  capability) pin behavior that was already correct.
- **Targeted mutants:** run on the final code, on the compiled code in a separate copy, with every file restored
  and hash-checked. Eleven of twelve single mutants are killed, and the remaining one is killed in combination
  (below). Killed:
  - removing the confirmation;
  - treating a confirmed conflict as pending;
  - accepting a receipt with the wrong binding (in `witness-client`);
  - ignoring the state kind (in `sameBinding`);
  - the pre-fix cleanup rule;
  - assuming ownership while keeping the organization check;
  - not settling the register claim on resume;
  - settling it on every resume outcome, including a refusal (H12);
  - no orphan settlement;
  - quarantining when the confirming read is unreadable.
- **Redundant layers:** not recording a refused claim (H07) and removing the pre-claim ledger check (H11) each
  survive alone, because each covers the other for a consumed capability. Removing both is killed by the
  refused-claim test.
- **Not exercised:** a refusal is also recorded when the claim *throws*. No test forces the ledger to throw
  mid-claim. That path only ever fails closed.
- **Equivalent mutants:** dropping the execution-id, binding-digest or organization cross-checks from the
  ownership rule doesn't change behavior. A capability id is unique in the ledger, and the intent is recorded
  from the same verified capability, so those checks are defence in depth.
- **Unchanged code, already covered:** reopening a consumed claim and treating a lost acknowledgment as success
  are code this increment doesn't touch. They are covered by the earlier M04 and M12 mutants.

- **Independent review** (a fresh read-only AI agent; **not a human review**). It found no Medium or higher
  issue. It confirmed:
  - the confirming read cannot be steered: it uses a fresh challenge and the pinned key, has an exact binding,
    and `atGenesis` checks this store id and digest;
  - no genuine contradiction is downgraded;
  - no misrouted receipt can quarantine or complete a registration.

  It also raised:
  - **Low, reproduced:** the "lost refusal fails closed" claim was wrong. The comment and §14.2 were corrected,
    and a pre-claim ledger check narrows the window.
  - **Info:** only the first page of unresolved claims was read. Fixed; every page is read now.
  - **Info:** the §14.1 table placed the local sites in the wrong row. Corrected.

This remains internal and non-operational. Nothing new is reachable from the Host, the executor or its
supervisor; the executor gate is unchanged; `bootstrapExecution` stays `disabled`.

**Production activation: NO-GO.**

## 15. B3C-2A2A: first FV administrator enrolment (implemented; internal and non-operational)

B3C-2A2 was split. **2A2A**, the first administrator, is implemented here. **2A2B** (further operators, by an FV
administrator's decision) needs its own AUTH-03 challenge domain and stays design only (§10). Revocation is
still B3C-2A3 (§11).

Code: `sovereign-status-history/identity-registration-first-administrator.ts` (the ceremony) and
`human-identity/first-administrator.ts` (the AUTH-03 rows). Nothing in the Host, its scripts, its deployment,
the dedicated executor or its supervisor reaches either, and neither is exported from a module index
(structure tests pin all of this).

### 15.1 Authority

| | |
|---|---|
| Action | `frontera.fv-bootstrap-identity.enroll-first-administrator` (resume: `…resume-first-administrator`) |
| Binding | `frontera.fv-first-administrator-binding.v1`, recomputed by the ceremony. It covers the enrolment id, the registration (id, store id, path, witness id and key digest, deployment, signing key), the store head **at genesis** (sequence 0 and its digest), the candidate's operator id and display name, the role `fv-administrator`, the relying-party id, and `credentialDigest` (`null` to enrol; exactly the recorded credential for a resume) |
| Issuer | A pinned **registration** issuer (G-02A verifier: pinned keys, exact audience, organization and trust domain, ≤ 60 s window). Independent of the store and of the Host. No production issuer exists; issuance is test-only |
| Execution id | The enrolment id (`fvadm-…`). A resume's must differ, whichever pinned issuer signs it: G-02A's ledger is unique only per issuer, so this check is what stops a second pinned issuer reusing it |
| Window | G-02A's verifier: issued-at/expires-at, ≤ 60 s; checked when presented, and again after the passkey answers |
| Credential | Not in the enrol capability: the credential does not exist when it is issued. It is bound by the WebAuthn challenge, derived from the capability id and a fresh nonce, and committed in the first row's plan digest. A resume capability names it exactly (`credentialDigest`) |
| Not interchangeable | The registration, resume-registration, enrol and resume-enrol actions and their binding formats are distinct; a registration capability presented to enrol is refused (tested) |
| Not accepted | A Host administrator (`identityAdministratorFor`), any operator-plane credential, an AUTH-02 enrolment token, a configuration flag. The administrator never authorizes itself, and the person running the ceremony becomes nothing |

### 15.2 Sequence

1. Lock the registration record exclusively. It must be `registered`, for exactly this configuration, signed over
   its binding by a pinned issuer, on the file the registration reserved.
2. Verify the capability against the recomputed binding. Nothing is consumed yet.
3. Read the recorded intents. A malformed one is ignored. Whether an enrolment exists is decided by the store in step 4, never by the record's events.
4. Open the store as its exclusive, pinned, FV-domain owner under CORE-07 freshness, never creating it. It must
   hold **no row at all**. Otherwise it is refused: `ALREADY_ENROLLED` when its rows are a recorded intent's
   complete plan, `ENROLLMENT_PENDING` when they are the beginning of one, and `STORE_NOT_EMPTY` otherwise. An earlier intent whose ceremony never wrote the store is superseded, and its capability
   claim is settled `failed`.
5. **Proof of possession, before consumption.** The candidate's authenticator answers a challenge derived from
   the capability id and a fresh nonce. The attestation is verified the way AUTH-02 verifies an ordinary
   registration: pinned RP ID and origins, user presence and user verification, supported algorithms, an
   importable key. A refused, failed, misdirected or unverified passkey consumes nothing.
6. Verify the capability again (its window may have closed while the human answered).
7. Consume it in G-02A's ledger, with HF01's claim-intent and refusal events.
8. Record the whole plan in the registration record (`first-administrator-intent`): the stored capability and
   signature, the nonce, the raw attestation, and the rows' fields.
9. Append three rows, each signed, chained and witnessed by the store's ordinary `append`:
   - `principal_created`, with `role: 'fv-administrator'`, the authorizing capability id and issuer, and
     **`planDigest`**: a digest of the whole plan (credential, enrolment id, token verifier, time, authorization);
   - `enrolment_authorized`, **born expired at the epoch** (never a plan-chosen time), its token verifier the
     digest of a secret that is discarded at once, so it is never an open invitation and can never be presented;
   - `credential_registered`, which consumes that enrolment.
10. `enrolled` only when the verified store holds exactly those rows **and** a fresh witness read shows that head
    committed, with nothing pending.

**The store pins the plan.** Once the first row is signed and witnessed, every later row must be exactly that
plan's. The ceremony's record — which its host's user can rewrite — never decides what the rows say: a resume
completes only the recorded intent that the store's own first row is the beginning of.

**AUTH-03 rule (`appendFirstAdministrator`).** Each append's guard admits the row only when the verified history
is exactly the earlier rows of this same plan. A store holding anything else (another administrator, the Host's
humans, a decision) is refused, `HUMAN_IDENTITY_FIRST_ADMINISTRATOR_CONFLICT`, with nothing written. The
record's events, the capability's genesis-head binding and this rule each prevent a second administrator by
this path.

### 15.3 Crash and recovery

| Interrupted after | Store | Outcome | Recovery |
|---|---|---|---|
| Consumption, before the plan was recorded | Empty | Capability spent; nothing recorded | A new capability enrols; the orphan claim is settled `failed` by HF01's rule |
| The plan was recorded, before the first row | Empty | `pending` in the record only; a resume is refused (`NO_ENROLLMENT: STORE_EMPTY`), consuming nothing | A **new** enrol capability; the earlier claim is settled `failed` |
| The first or second row | 1 or 2 rows | `pending`; a new enrolment is `ENROLLMENT_PENDING` | A resume capability naming the `credentialDigest` of the plan the first row pins |
| The last row, before completion was recorded | 3 rows | The record says `pending`; the store is the authority | A resume reports `enrolled` and consumes nothing |
| A finalize that never reached the witness (last row) | 3 rows locally, the last prepared at the witness | `pending`, never `enrolled` | A resume reopens the store (CORE-07 finalizes it) and reports `enrolled`, consuming nothing |
| A lost finalize answer before the last row | — | The store finalizes it before its next row; `enrolled` | — |
| A prepare the witness applied, its answer lost | Prepared at the witness, not committed locally | `pending`; the resume is refused `STORE_REFUSED` (`AUTHORITY_FRESHNESS_PENDING_RECOVERY`), nothing consumed | Needs trusted operational recovery (B3C-2B); an existing CORE-07 limit, failing closed |

Before it consumes anything, a resume opens the store and selects the recorded intent whose plan the first row
pins; a rewritten intent matches none and is refused (`ENROLLMENT_CONFLICT`). As defence in depth it then
re-verifies that intent: the stored capability's signature by a pinned issuer over the binding recomputed from
the record and the plan, and the stored attestation against that capability's challenge, which must prove
exactly the plan's credential (`RECORD_CORRUPT: AUTHORIZATION_UNVERIFIED` otherwise).

### 15.4 Limits (documented, not fixed here)

- **Same-user writer.** The record's events are not cryptographic evidence; the store's first row is. A same-user
  writer (without the deployment's signing key) can insert or rewrite an intent, re-creating the trigger:
  - before the first row, nothing can be resumed: the inserted intent is ignored, and a genuine enrolment
    supersedes it;
  - after it, a rewritten intent matches nothing the store pinned and is refused, even with a resume capability
    a misled issuer signed for the forged credential;
  - what remains is a denial of service: a rewritten or deleted intent makes the genuine resume
    `ENROLLMENT_CONFLICT` or `NO_ENROLLMENT` until the record is restored;
  - the view (`readFvFirstAdministratorEnrollment`) is **record-only evidence**: it can show a forged digest, or
    `enrolled` over an empty store;
  - forged completion events and malformed intents block nothing, because enrolment decides from the store
    (publication review, finding 1). The
    issuer of a resume capability must confirm `credentialDigest` with the candidate's own authenticator out of
    band.

  As in §12, excluding a same-user attacker is a deployment requirement.
- **WebAuthn assurance level (exactly what is verified).**
  - **Verified:** a `webauthn.create` ceremony, for this authorization's challenge; the pinned RP ID hash and an
    allowed origin, not cross-origin or embedded; user presence **and** user verification; a supported algorithm
    (Ed25519, ES256, RS256) and an importable public key; the attested credential id equal to the response id.
  - **Not verified:** attestation is `none`, as in AUTH-02, so there is no authenticator provenance, AAGUID
    allow-list, certification level or hardware binding. A software authenticator satisfies it; the tests use one.
    That is **not** a production assurance claim.
  - The issuer authorizes a *person* (operator id, display name). Binding that person to the device is the
    out-of-band ceremony's job.
- **The Host path (closed by 2A2B, §16.1).** At 2A2A, AUTH-02's service composed over the FV store still accepted a
  Host `IdentityAdministrator`. Since 2A2B, an FV store refuses every general administrative act, token
  registration and owner revocation.
- **The executor does not yet require an administrator.** The `registration` gate is unchanged; requiring an
  enrolled administrator is an activation blocker, alongside making the gate mandatory.
- **The witness and the SQLite files are not one atomic transaction.** Each boundary is recoverable from evidence
  instead, as listed above.

### 15.5 Evidence

- **Tests.**
  - `tests/fv-p4c2b3c2a2a-first-administrator.e2e.test.mjs`: 22 tests. They use the real 2A1 registration, the G-02A verifier and ledger, a CORE-07 reference witness, AUTH-03 stores, AUTH-02 WebAuthn verification with software passkeys, and child processes that are SIGKILLed or paused.
  - `fv-p4c2b3c2a2a-first-administrator-structure.test.ts`: 6 tests.
  - Three existing structure pins gained exact, commented exceptions (the AUTH-02 file list, the AUTH-03 composers, the FV module's import allowlist). No assertion was removed.
- **Regression** on the exact tree, all passing:

  | Suite | Result |
  |---|---|
  | HF01 | 16/16 |
  | B3C-2A1 | 43/43 |
  | B3C-3 | 10/10 |
  | B3B | 31/31 |
  | B3C-1 | 41/41 |
  | FV-EXEC-LOCK-01 | 11/11 |
  | All structure tests | 565/565 |
  | AUTH-02/03/04 | 197 pass, 2 skipped (pre-existing) |
  | CORE-07 | 112/112 |
  | G-02A | 92/92 |

  Gates, all passing: typecheck, lint, `check:aoc-boundaries`, `check:release-coherence`, `check:protocol-consumption`, `validate:publishability` and `legal:check`.
- **Targeted mutants: 20 of 23 single mutants killed**, plus two combined mutants and a reconstruction of the
  pre-fix recovery, all killed. They ran on the compiled code in a separate copy, and every file was restored and
  hash-checked.
  - **Killed:**
    - the empty-store check;
    - the attestation challenge;
    - the re-check of the capability window after the human answers;
    - the enrolment's execution id, and the resume's (A13: killed once a second pinned issuer is tested; G-02A's
      ledger is unique only per issuer, so the check is not redundant);
    - re-verifying the recorded attestation, and the recorded capability's signature (A08);
    - the witness confirmation before `enrolled`;
    - binding the resume to the credential;
    - settling the enrol claim on resume;
    - the completed-enrolment check;
    - the plan pin in the first row;
    - resuming into an empty store;
    - trying only the first matching intent;
    - an enrolment row born open;
    - the role;
    - admitting a pending registration;
    - the registration's signature check;
    - settling superseded claims.
  - **Pre-fix reconstruction (killed, 3 of 4 targeted tests fail):** the record selects the latest intent,
    including over an empty store; no plan pin; expiry taken from the plan's time. So the F1–F3 regression
    tests catch the vulnerable recovery.
  - **Surviving: 3.**
    - **A02 and A03: B, a redundant control pair.** The rows module checks the history twice. The initial prefix
      check guards the first append; each append's guard re-decides inside the store's transaction. Each one
      alone catches every sequential case. Removing both (A04) is killed. The guard additionally covers a write
      landing between the two, which only a second writer could cause, and B3C-3's exclusive lock and fence
      exclude that.
    - **A10: C, unreachable under the protocol.** Dropping the recorded capability's binding check survives,
      even together with the signature check removed (A24, killed only by the signature case). A recorded
      capability with another binding but a valid issuer signature is a different capability, with another id.
      The first row records the authorizing capability id, signed and witnessed, so such an intent never
      matches the store and is refused (`ENROLLMENT_CONFLICT`, tested) before this check runs.
- **Independent review** (two fresh read-only AI agents of the same model family; **not a human review**):
  - **First review.** It reproduced two High findings and one Low/Medium. A rewritten ceremony record could:
    - substitute the administrator's passkey after a crash;
    - make the enrolment row an open invitation with a known token, through unbound plan fields;
    - complete an intent whose capability was never consumed.

    **Fixed:** the first row now pins the whole plan, a resume refuses an empty store, and the enrolment row is born expired at the epoch. Each scenario is now a regression test, and the reviewer's probe fails on every one.
  - **Second review** (after the fix). It confirmed the three findings are closed under the stated model, and reproduced two more:
    - **Medium-Low:** a passkey with a long, valid credential id passed attestation, then made the ceremony throw *after* consuming the capability. **Fixed:** the plan is built and validated before consumption, and an unrepresentable credential is refused.
    - **Low:** settling "superseded" intents' claims bypassed HF01's ownership rule, so a forged intent could mark another tenant's claim `failed`. **Fixed:** the ceremony settles only claims it made in that call.

    It also raised a denial-of-service case: a broken copy of the genuine intent recorded first hid it. **Fixed:** every matching intent is tried. Both probes now come out right.
  - **Info, documented here:**
    - AUTH-02 ignores `role`, so 2A2B must read it from the signed row.
    - The view can be misled by a forged record.
    - The authenticator has no timeout, which is a liveness limit only.
- **Publication review of `3f76f21e`** (PR #265; a fresh read-only AI agent, **not human**). No finding blocks merge,
  and all 14 priority questions came back clean for authority. One Low was reproduced: a forged completion event
  inserted into the unsigned record made a genuine enrolment `ALREADY_ENROLLED` (a denial of service), and a
  malformed intent made it `RECORD_CORRUPT`. **Fixed:** enrolment decides from the store's rows, and malformed
  intents are ignored. Tested. Info, documented: Host administration of an FV store (2A2B); a resume of a
  complete enrolment is not consumed; the allowed origins come from the ceremony's configuration, as its pins do.

This remains internal and non-operational. Nothing new is reachable from the Host, the executor or its supervisor; the executor gate is unchanged; `bootstrapExecution` stays `disabled`.

**Production activation: NO-GO.**

## 16. B3C-2A2B: FV operator enrolment under the FV administrator's authority (implemented; internal and non-operational)

Code:
- `human-identity/fv-domain.ts`: FV roles, read from signed rows.
- `human-identity/fv-operator.ts`: AUTH-03 verifies and appends an operator enrolment.
- `human-identity/service.ts`: AUTH-02's general administration refuses FV stores.
- `sovereign-status-history/identity-registration-operator.ts`: the offline ceremony.

Nothing in the Host, its scripts, its deployment, the dedicated executor or its supervisor reaches any of them, and none is exported from a module index (structure tests pin all of this). Revocation, administrator recovery or replacement, and credential rotation remain B3C-2A3 and later.

### 16.1 Host and FV: separate administrative domains

**Host administrator authority never implies FV administrator authority.** AUTH-02's service refuses `HUMAN_IDENTITY_FV_ADMINISTRATION_REFUSED`, writing nothing, on an **FV store**. A store is an FV store when either:
- it is opened by its exclusive FV owner (`exclusive`; the store reports `exclusiveOwner`); or
- its **signed history begins with the FV administrator**. This marker is durable: it holds even through a plain handle.

The refused operations are:
- `createPrincipal`, `revokePrincipal`, `authorizeEnrolment`, `revokeEnrolment`, `revokeCredential`: the administrator check, and again inside each append's guard;
- enrolment-token registration (`beginRegistration`, `finishRegistration`);
- owner revocation (`beginOwnerRevocation`, `finishOwnerRevocation`). FV revocation is B3C-2A3's.

**Unchanged:** authentication, human decisions, bootstrap-authority decisions and their settlement, which the FV composition uses. Ordinary Host stores keep their Host administration (tested).

**What remains, and is the trusted boundary:** the store's own `append`. Only the FV ceremonies' AUTH-03 rules call it on an FV store; test support also calls it, to move an FV store's freshness position. Before the first administrator exists, a plain handle (one that was neither opened exclusively nor anchored) has no FV marker yet. Writing through it is a same-user act outside the witness, and the witness refuses the store afterwards as a fork (tested).

### 16.2 Roles (from signed rows only)

| Role | Rule | May |
|---|---|---|
| `fv-administrator` | `principal_created` at **sequence 1**, `role: 'fv-administrator'`, recorded by the first-administrator ceremony. AUTH-03 appends it only into an empty store, so there is at most one | Authorize FV operator enrolments in its own store |
| `fv-operator` | `principal_created`, `role: 'fv-operator'`, recorded by the operator ceremony, **immediately after** the administrator's authorizing `credential_used` row. That row's stored contract must recompute to the commitment both rows name, and must name exactly this principal and that administrator credential. `verifyFvOperatorRoles` re-verifies the administrator's stored assertion from the store alone | Prove its identity. Nothing else: no administration, no self-promotion |
| (none) | Any other principal: one a Host administrator created, a display name, a position, another recorder's field | — |

No role authorizes a document action, a bootstrap verdict, or anything in CORE-05. Nothing in this increment creates a second administrator.

### 16.3 Authorization: the administrator's assertion over the exact request

The ceremony does three things, in order:
1. The **candidate proves possession first.** A passkey attestation (user verification, pinned RP ID and origins) answers a challenge derived from the request id and a fresh nonce.
2. The **administrator then authorizes exactly that enrolment.** It makes a WebAuthn assertion, with one of its own active credentials, over `webAuthnChallengeOf(commitment)`. The commitment covers the canonical `frontera.fv-operator-enrollment-authorization.v1` contract:
   - the action `frontera.fv-bootstrap-identity.enroll-operator`;
   - the request id;
   - the organization, deployment, FV state kind, store id, witness id and key digest;
   - the store's **exact prior head** (sequence and chain digest);
   - the administrator and its credential;
   - the candidate: operator id, display name, user handle, the digest of the credential it *already proved*, and that proof's challenge digest;
   - the role `fv-operator`;
   - the enrolment row's id and token verifier;
   - a validity window of **at most 300 s**, whose start is also every new row's `recordedAt`.

   Every field of the rows is therefore signed (review L1).
3. **AUTH-03 decides it** (`verifyFvOperatorEvidence`), against the store's own verified history and with the caller's configuration for the deployment, state kind and witness:
   - the prior head, recomputed;
   - the administrator's role, read from signed rows at that head;
   - the administrator's credential: its own, and active;
   - the assertion, verified by the AUTH-02 library path with user verification required. The counter must advance past the stored one, and the user handle must be the administrator's;
   - the candidate's attestation, which must be the approved credential;
   - no existing principal or credential, and no consumed challenge;
   - the window, while no row is written yet.

**Why not G-02A.** An FV administrator holds a passkey, not an issuer key; making the registration issuer sign every operator enrolment would defeat the administrator's authority. Single use comes from the store itself instead:
- the first new row, `credential_used`, consumes the administrator's challenge (a chained, signed, witnessed row);
- the authorization is bound to the prior head, which that row moves.

So a replay, a second use or a stale authorization is refused (`STALE_HEAD`, `ASSERTION_INVALID`), and the protection is anchored by CORE-07 rather than by a ledger file. **The ceremony touches no G-02A ledger** (tested), so HF01's claim ownership is unaffected.

**Retry contract.** An authorization is valid only at its exact prior head. If another enrolment, or any other write, advanced the head before this one's first row, it is refused and must be authorized again.

### 16.4 Rows (the signed plan)

These are appended by `appendFvOperator`, each signed, chained and witnessed, only onto the exact prior head. Each append's guard re-decides the prior head and the exact prefix of the plan.

1. `credential_used`, for the administrator's credential. It carries:
   - the counter and the consumed challenge digest;
   - the authorization commitment, **the signed contract itself** and **the administrator's raw assertion** (so the role can be re-verified from the store; review M1);
   - a **digest of the whole plan**, so the first new row pins the rest.
2. `principal_created`, carrying `role: 'fv-operator'`, the commitment, and `authorizedBy`.
3. `enrolment_authorized`: born expired at the epoch; its token verifier is the digest of a secret that is discarded at once.
4. `credential_registered`: the candidate's credential.

`enrolled` is reported only when the verified store holds all four rows **and** a fresh witness read shows that head committed with nothing pending.

### 16.5 Crash and recovery

The registration record holds only *progress* (`operator-enrollment-intent`, carrying the evidence). A resume (`resumeFvOperatorEnrollment`) **re-verifies** that evidence against the signed history. The record authorizes nothing by being recorded: a forged intent must still carry an assertion by the administrator's key over its own commitment. Every recorded copy for the request is tried, and malformed ones are ignored.

| Interrupted after | Store | Recovery |
|---|---|---|
| The candidate's or the administrator's proof, before the intent | Unchanged | Nothing to resume (`NO_REQUEST`); make a new request |
| The intent | Unchanged | A resume completes it, while the window is open and the head unchanged; otherwise `WINDOW_CLOSED` or `STALE_HEAD`, and the enrolment must be authorized again |
| 1–3 rows | The first row pins the plan | A resume completes exactly that plan, even after the window (the first row was its consumption, in time). Until then, **nothing else is written to the store**:
  - every new enrolment is refused (`ENROLLMENT_PENDING`; AUTH-03 `PLAN_INCOMPLETE`);
  - every AUTH-02 write (authentication, decisions, settlements, counter anomalies) is refused (`HUMAN_IDENTITY_FV_ENROLLMENT_PENDING`).

  So the plan stays the history's suffix, which is what its resume needs. Otherwise it would be stranded, and its principal would block a new authorization (Codex P2 on PR #267; the fix-commit review's F1). This fails closed: the FV store accepts no human authentication or decision until the enrolment is resumed |
| All 4 rows, before completion is reported | Complete | A resume reports `enrolled` and writes nothing |
| A finalize that never reached the witness | The last row is prepared at the witness | `pending`, never `enrolled`. A resume reopens the store, CORE-07 finalizes it, and the resume completes |
| A prepare the witness applied, its answer lost | — | `pending`; the resume is refused `STORE_REFUSED` (`AUTHORITY_FRESHNESS_PENDING_RECOVERY`). This is the existing CORE-07 limit and fails closed; recovery is B3C-2B |

There is no force-complete and no reset.

### 16.6 Concurrency

One ceremony runs at a time per registration: the record's exclusive lock gives `REGISTRAR_BUSY` (tested with real processes). The store has its single exclusive owner (B3C-3). The cases:
- **Several operators:** they are enrolled one after another, each authorization at its own head.
- **The same operator twice:** `CANDIDATE_EXISTS`.
- **One credential for two principals:** `CREDENTIAL_DUPLICATE`.
- **An authorization prepared at a head another enrolment then advanced:** `STALE_HEAD`.
- **A Host administrative act** on the FV store, at any moment: refused.

### 16.7 Limits (documented, not fixed here)

- **WebAuthn assurance.** It is the same as §15.4: attestation `none` for the candidate, and no authenticator provenance. The tests use software authenticators, so this is **not** a production assurance claim. The administrator's assertion requires user verification.
- **The candidate's identity** (operator id, display name) is whatever the administrator approves. Binding it to a real person is the out-of-band ceremony's job.
- **The ceremony's deployment, state kind and witness** come from its trusted configuration, checked against the registration record. AUTH-03 trusts the caller for that scope, the same trust level as the pinned issuers.
- **Mid-plan crash (fail closed; review of the latest delta, L1 and L2).** Until the enrolment is resumed, the FV
  store accepts no AUTH-02 write: no authentication, decision, settlement or counter-anomaly record.
  - **The lockout lasts as long as the resume fails.** The resume re-verifies the recorded evidence under the
    ceremony's configuration. So a changed relying-party origin, a deployment or witness-key rotation (scope
    mismatch), or a lost or corrupted registration-record intent keeps the store locked. Restoring the original
    configuration or record lets it resume (reproduced).
  - **Operational rule:** resume an interrupted enrolment before changing any of that configuration.
  - **No other way out:** there is no recovery other than the resume until B3C-2A3's governance recovery. The same
    holds for a signing-key holder's consistent forged plan start.
  - **A counter anomaly (a possible cloned authenticator) seen mid-plan is refused but not recorded,** because its
    row is a write too. It still fails closed.
  - **Unaffected:** a CORE-05 outcome is best-effort and read back from the CORE-05 log. A refused bootstrap
    settlement stays `unresolved` and is retried. No decision can be authorized mid-plan.
- **Signing-key holder (a trust root).** The store's signing key, the deployment's authority key (CORE-02), signs
  every row, so its holder can append any row (§12).
  - **What review M1's fix gives:** a bare `fv-operator` row gets no role, and a structurally consistent forged pair
    gets one that `verifyFvOperatorRoles` refuses.
  - **What it does not give:** that verifier proves the operator was authorized by *a credential the signed history
    attributes to the administrator*. A key holder could also append such a credential, or, before the first
    administrator exists, a first row of its own.
  - **Not implemented:** anchoring the administrator's credential in the issuer-signed capability recorded at
    registration. That is a candidate for B3C-2A3 or activation.
  - **Consumer rule:** whatever later trusts the operator role must use `verifyFvOperatorRoles`, never `fvRolesOf`
    alone. Today no consumer trusts it: every current use of `fvRolesOf` checks only the administrator role (a
    structure test pins this).
- **Same-user writer.** Without the signing key, a same-user writer can only deny service: it can delete or garble the record's intents, or write a plain-handle row outside the witness, which then refuses the store. With the signing key, the trust limits of §12 apply.
- **The executor is unchanged.** Enrolled administrators and operators make nothing operational. `bootstrapExecution` stays `disabled` (tested), and requiring an administrator or an operator is an activation blocker.

### 16.8 Evidence

- **Tests.**
  - `tests/fv-p4c2b3c2a2b-operator-enrollment.e2e.test.mjs`: 31 tests, with real child processes paused or SIGKILLed. They include a role-forgery matrix, each case scored both structurally and by the verifier, a request under another deployment's configuration, and a rolled-back store that never revives a consumed authorization.
  - `fv-p4c2b3c2a2b-operator-enrollment-structure.test.ts`: 5 tests.
- **Existing tests that wrote to FV stores through Host administration** were moved to an FV-legitimate write. Every one of their assertions is kept:
  - the B3B support's anchored FV worlds now enrol their humans the FV way;
  - one B3C-3 step advances the FV store by an FV human's authentication;
  - the CORE-07 freshness helper advances FV stores by one trusted append;
  - one 2A2A test now asserts the witness's fork refusal of a Host write made outside the witness.
- **Existing structure pins** gained exact, commented exceptions. No assertion was removed.
- **Regression on the exact tree**, all passing:

  | Suite | Result |
  |---|---|
  | B3C-2A2B | 31/31 |
  | B3C-2A2A | 22/22 |
  | HF01 | 16/16 |
  | B3C-2A1 | 43/43 |
  | B3C-3 | 10/10 |
  | B3B | 31/31 |
  | B3C-1 | 41/41 |
  | FV-EXEC-LOCK-01 | 11/11 |
  | All structure tests | 576/576 |
  | AUTH-02/03/04 | 197 pass, 2 skipped (pre-existing) |
  | CORE-07 | 112/112 |
  | G-02A | 92/92 |
  | PROD-02 | 57/57 |

  Gates, all passing: typecheck, lint, `check:aoc-boundaries`, `check:release-coherence`, `check:protocol-consumption`, `validate:publishability` and `legal:check`.
- **Targeted mutants: 24 of 26 applicable killed** (including the publication review's verifier-position check and the unfinished-plan refusal). Removing both unfinished-plan checks, which is the pre-fix behaviour, fails all three Codex P2 regression tests. They ran on the compiled code in a separate copy, and every file was restored and hash-checked.
  - **Killed:**
    - Host administration accepted on an FV store;
    - the FV marker taken only from the handle, or only from the history;
    - the administrator's assertion signature skipped;
    - the administrator's role unchecked;
    - the organization, the deployment or the prior head unbound;
    - the candidate's proof accepting any challenge;
    - candidate substitution;
    - operator escalated to administrator;
    - the operator role granted without its authorizing row;
    - the role re-verification skipping the assertion;
    - an unsigned row time;
    - an expired window accepted;
    - credential or principal uniqueness unchecked;
    - `enrolled` reported without the witness readback;
    - the store fence unchecked (a store file replaced under a paused ceremony);
    - bootstrap enabled.
  - **The consumed-challenge check: killed, after correcting an earlier classification.** It was first classified as unreachable, but re-checking showed it is reachable. A direct AUTH-03 caller can present a *new* candidate credential answering an earlier, consumed candidate challenge (the same request id and nonce) under a genuine administrator signature at the new head. Without the check, AUTH-02 would read the doubly consumed challenge as a corrupt store. It is now tested.
  - **Killed: AUTH-02 writing to an FV store mid-plan** (the fix-commit review's F1).
  - **Surviving: the ceremony's early unfinished-plan refusal: B, redundant.** AUTH-03 refuses the same plan (`PLAN_INCOMPLETE`, killed when removed). The early check only spares the humans a ceremony that would be refused.
  - **Surviving: the append guard's length and chain check: B, redundant under store invariants** (corrected from "equivalent" by the publication review). The guard's plan-prefix check does not imply them by itself; for a history shorter than the prior head it returns 0. They are implied only by the store's own invariants: an append-only, chain-verified history, the exclusive write fence, the file-identity check, and CORE-07's rollback refusal. These are tested in B3C-3, 2A1 and here. It is not exploitable.
  - **Not applicable:** "accept a forged recovery record" has no record-trusting branch to mutate; the checks a forged record must pass (the signature and the candidate) are mutated and killed. "Wrong-slot witness evidence" is CORE-07's, covered by HF01's H03 and H04.
- **Independent review** (a fresh read-only AI agent of the same model family; **not a human review**). No Critical or High. It reproduced:
  - **M1, Medium:** the `fv-operator` role was read from any signed row with the right recorder, so a holder of the store's signing key could add an operator without the administrator's signature. **Fixed:** the role needs the authorizing row directly before it, and `verifyFvOperatorRoles` re-verifies the stored assertion. Both are tested.
  - **L1, Low:** the enrolment id, token verifier and time were not signed; a record writer could backdate the rows on a resume. **Fixed:** all three are in the signed contract. Tested.

  Info items, documented here:
  - the non-administrative AUTH-02 paths (authentication, decisions) still write to FV stores, by design, and advance the head;
  - an empty store can be pre-poisoned through a plain handle, which is a denial of service only;
  - the test-only authenticator export stays under `__tests__`.

  After the fixes, the reviewer's probe gives no role to the raw row, and ignores the rewritten unsigned fields.
- **Publication review (PR #267, head `0830b2fa`; a fresh read-only AI agent, not human).** Nothing blocks merge, and
  the changes to existing tests hide no regression. It reproduced:
  - **F1, Low:** `verifyFvOperatorRoles` accepted an approval AUTH-03 had refused as stale, if a signing-key holder
    appended its signed rows later. **Fixed:** the verifier now requires the approval's prior head and chain digest
    at exactly its row's position, this organization, and the approved credential registered right after. Tested.

  It also corrected the surviving mutant's classification, above.
- **Codex review of `0830b2fa`: P2, REPRODUCED by Codex, fixed.** After a crash mid-plan, a new enrolment by another
  request could complete and strand the earlier operator without a credential: a resume gave `STALE_HEAD`, and a
  re-authorization gave `CANDIDATE_EXISTS`. **Fixed:** a new enrolment is refused while the history ends in an
  unfinished operator plan. Plans are contiguous, so an unfinished one is always the suffix. The check is in AUTH-03
  and, earlier, in the ceremony. Tested at each partial-plan boundary: the stranded plan then resumes, and the next
  enrolment proceeds.
- **Review of the latest delta (`30314b04`)** (a fresh read-only AI agent, not human). It closed F1 by reproduction,
  at each partial point, and found no bypass among the 12 service writes and no change for Host stores. It raised two
  Lows, L1 and L2, both fail closed and documented under the mid-plan crash limit above.
- **Review of the two fix commits** (a fresh read-only AI agent, not human). The verifier fix holds. It reproduced:
  - **F1, Medium:** an AUTH-02 write after a mid-plan crash (authentication is allowed on FV stores) stranded the plan.
    With the P2 fix, that then blocked every future enrolment. **Fixed:** AUTH-02 refuses every write to an FV store
    while a plan is unfinished, so the plan stays the suffix and resumes. Tested: the authentication is refused, then
    the resume and the next enrolment succeed. The reviewer's probe now shows the refusal.
  - **F2, Low:** one garbage operator-ceremony row by a signing-key holder blocked enrolment for good. **Fixed:** a
    plan start needs a contract that recomputes to its commitment. Tested. A *consistent* forged plan start by a
    signing-key holder can still block the store until B3C-2A3's governance recovery (a trust-root denial of service,
    documented).

This remains internal and non-operational. Nothing new is reachable from the Host, the executor or its supervisor; the executor gate is unchanged; `bootstrapExecution` stays `disabled`.

**Production activation: NO-GO.**

## 17. B3C-2A3A: FV operator credential revocation (implemented; internal and non-operational)

B3C-2A3 was split. **2A3A** (revoking an FV operator credential) is implemented here. **2A3B** (governance recovery,
administrator revocation and the interrupted-enrolment escape) is **design only** (§18).

Code:
- `human-identity/fv-revocation.ts`: AUTH-03 verifies and appends a revocation, and provides the current-authority verifiers.
- `sovereign-status-history/identity-registration-revocation.ts`: the offline ceremony.

Nothing in the Host, its scripts, its deployment, the dedicated executor or its supervisor reaches either, and neither is exported from an index (structure tests pin all of this).

### 17.1 Semantics (what this is, and is not)

| Operation | In 2A3A |
|---|---|
| **Revoke one FV operator credential** | **Yes.** It is an append-only `credential_revoked` row. The history keeps the enrolment and every earlier signature as historical evidence |
| Principal deactivation, role removal | No. The principal and its signed role row remain, but with no active credential the operator has no **current** authority |
| Administrator revocation or replacement | No (§18). The administrator is never a target |
| Credential replacement or rotation | No. An FV operator has **one** credential: the operator ceremony refuses a second for an existing principal (`CANDIDATE_EXISTS`). A fully revoked operator cannot be re-enrolled under the same operator id; a new id needs a new administrator authorization |
| Reactivation | None exists. A revoked credential stays revoked |

### 17.2 Authority

The FV administrator signs a WebAuthn assertion over the commitment to `frontera.fv-operator-revocation-authorization.v1`. The assertion must be user verified, with the pinned RP ID and origins and an advancing counter. The contract covers:
- the action `frontera.fv-bootstrap-identity.revoke-operator-credential` and the request id (`fvrev-…`);
- the organization, deployment, FV state kind, store id, witness id and key digest;
- the store's **exact prior head**;
- the administrator and its credential;
- the target: operator id, credential id, and the digest of that credential's key, so the target is never silently replaced;
- a reason code (`compromised`, `lost`, `offboarded` or `other`);
- a window of at most 300 s, whose start is the row's time.

The target operator takes no part, and no possession of the revoked credential is needed.

**AUTH-03 decides it** (`verifyFvRevocationEvidence`) against the store's own verified history, at that exact head:
- no unfinished operator enrolment;
- the administrator's role, from signed rows, with an active principal and its named credential **currently active**;
- the target is a cryptographically verified FV operator (`verifyFvOperatorRoles`), its own named credential, with exactly the approved key, and is not the administrator;
- the assertion and its counter, with the challenge unused;
- while nothing is written yet: the credential still active (`ALREADY_REVOKED`) and the window open.

No Host administrator, Host session, raw principal id, flag, registration issuer or G-02A capability is involved. The ledger is never touched (tested).

### 17.3 The signed row

The revocation is **one** `credential_revoked` row, appended only onto the exact prior head. It uses AUTH-02's own owner-revocation shape, so AUTH-02's projection both revokes the target and records the asserting administrator credential's use and counter. It also carries:
- the consumed challenge digest (single use);
- the commitment, **the signed contract** and **the administrator's raw assertion**, so it can be re-verified from the store alone.

A single row is never a partial plan, so it adds no resume deadlock and no interleaving. `revoked` is reported only when the verified store holds it **and** a fresh witness read shows that head committed with nothing pending.

### 17.4 Current-state verification

- **AUTH-02's projection** makes the revoked credential unusable at once, for authentication and for human and bootstrap decisions (tested).
- **`verifyFvCurrentOperators`** counts only verified operators whose principal is active and that still hold an active credential. That is current authority, distinct from historical membership (`verifyFvOperatorRoles`, which still verifies). A revoked credential never counts, whether an administrator revoked it or a forged row did.
- **`verifyFvRevocations`** re-verifies, from the store alone, **every** `credential_revoked` row of the FV store. A row is *authorized* only when all of these hold:
  - it is the revocation ceremony's;
  - every write-time condition of AUTH-03 that the history can still prove holds again at that position (review L2/L3; parity completed by AUDIT-HF01):
    - the contract and its commitment;
    - its scope, against the registration's authenticated binding (AUDIT-HF01): the organization, store id, deployment, FV state kind, witness id and witness key digest. The store id is compared explicitly: the prior chain digest is recomputed under the authorization's own claimed store id, so it does not bind that id by itself;
    - its signed lifetime: positive and at most 300 s (AUDIT-HF01);
    - the target, its key digest and its ownership, the target still active and a verified operator;
    - the position, chain digest and signed time;
    - an active administrator with its credential active, no unfinished plan, an unused challenge, an advancing counter and a valid signature;
  - the stored row is **byte-for-byte the row AUTH-03 rebuilds** from that contract and assertion, so no projected field (`assertedWith`, counter, reason) can be swapped under a genuine signature (publication review F1).

  The scope the audit checks against (`expected`) must be the registration's authenticated binding. That means the values every FV ceremony uses, read from the registration record as `fvRegisteredStoreAccess.registeredRecord` opens it: the pinned issuer's signature over that binding, plus the registrar's pinned configuration, including the digest of the pinned witness key. A caller-chosen scope proves nothing, and without a complete one nothing is authorized. One credential can appear in both result sets (a genuine revocation, then a replayed copy of its row later), so a consumer asks whether it is *authorized*, never whether it is absent from *unauthorized*.

  Otherwise the row is *unauthorized*, for example a holder of the store's signing key forging one. Either way the credential stays revoked: **a revocation only ever removes authority**. A forged revocation is still a real loss of access, an availability and governance issue (recovery is §18).
- **What `authorized` proves, and what it does not (publication review F2; AUDIT-HF01).** Two checks must be kept apart:
  - **The signed window's validity is checked.** The window's structure, its 300 s cap, and every other internally verifiable constraint of the contract hold.
  - **The actual append time is not established.** AUTH-03 checked the window against the ceremony's clock at write time. Neither the store nor the witness records a trusted append time; the reference witness's local `recorded_at` columns are unsigned metadata.

  So a holder of the store's signing key could later append a genuine, in-scope authorization the ceremony never used (one left in the unsigned record after `WINDOW_CLOSED`, say), at its exact head, if nothing else was written since (tested). `authorized` means "the administrator signed exactly this revocation, in this scope, for this position". It does not mean "approved at the time it was appended". It still only removes authority.
- **The administrator's current state is required.** If its credential is revoked (in 2A3A only by a forged row, since the administrator is never a target), it authorizes neither a revocation nor an enrolment (tested).
- **Freshness:** each decision reads the store's verified history under CORE-07 freshness. A rolled-back store never revives a revoked credential: the witness refuses it (tested).

### 17.5 Replay and idempotency

| Case | Result |
|---|---|
| The same request after completion | `revoked` re-reported, nothing appended (also after later rows) |
| A new request for a revoked credential | `ALREADY_REVOKED` |
| The same request id again | `REQUEST_PENDING` |
| A reused assertion for another target | `ASSERTION_INVALID` |
| A stale head (anything written since) | `STALE_HEAD` |
| An expired window with nothing written | `WINDOW_CLOSED` |
| Another organization or store | `SCOPE_MISMATCH` |
| A nonexistent, or another operator's, credential | `TARGET_CREDENTIAL_UNKNOWN` |
| A substituted key | `TARGET_MISMATCH` |
| A counter at or below the stored one | `COUNTER_REGRESSION` |

### 17.6 Crash, concurrency and enrolment interaction

- **Crashes (SIGKILL):**
  - after the administrator's proof, before the intent: nothing to resume (`NO_REQUEST`);
  - after the intent: a resume completes it while the window is open and the head unchanged; otherwise it must be authorized again;
  - after the row, before completion is reported: a resume confirms it.
- **Witness answers:**
  - a finalize that never reached the witness: `pending`, never `revoked`, and a resume confirms;
  - a prepare the witness applied, its answer lost: `pending`, then refused (`AUTHORITY_FRESHNESS_PENDING_RECOVERY`). This is the existing CORE-07 limit, which fails closed.
- **Forged records:** a rewritten, deleted or forged-complete record is refused or ignored, and the genuine evidence completes. The record holds progress only.
- **Ordering rule:** one ceremony at a time per registration (`REGISTRAR_BUSY`, tested with real processes).
  - **A revocation during an unfinished operator enrolment** is refused (`ENROLLMENT_PENDING`; AUTH-03 `PLAN_INCOMPLETE`). The enrolment is resumed first, then the revocation proceeds (tested at each partial-plan boundary).
  - **A revocation is one row,** so it never leaves the store mid-plan, and an enrolment after it simply authorizes at the new head.
  - **A revocation racing an authentication,** or any other write, finds its head stale and must be authorized again.
- **A store file replaced under a paused ceremony:** nothing reaches the witness, and a resume gives `STORE_FILE_MISMATCH`.

### 17.7 Limits

- **The store's signing key is a trust root.** Its holder can forge a revocation. That forgery only *removes* authority, which is a denial of service that `verifyFvRevocations` reports as unauthorized. The holder could also revoke the administrator's credential, after which nothing can be administered until §18.
- **WebAuthn:** attestation `none` for the administrator's original credential, and software passkeys in the tests. This is not a production assurance claim.
- **The administrator is a single trust root,** with no revocation, replacement or recovery in 2A3A (§18).
- **The mid-plan lockout of §16.7 is unchanged:** a revocation cannot release it.
- **The executor is unchanged:** nothing becomes operational, and `bootstrapExecution` stays `disabled` (tested).
- **No trusted append time (F2):** `verifyFvRevocations` cannot prove a row was appended within its signed window (§17.4). A delayed append of a genuine, unused, in-scope authorization is labelled authorized. It only removes authority, but it is a real loss of access the administrator may have abandoned.
- **The operator-role audit has the same class of gap (found by AUDIT-HF01; open, not fixed here).** `verifyFvOperatorRoles` (2A2B) does not re-check the store id, deployment, state kind, witness id, witness key digest or 300 s lifetime that its own write-time verification enforces (`fv-operator.ts`). Its comment that the chain digest "also binds the store id" is wrong, for the reason given in §17.4. Unlike F-A, this one can *grant* standing: an administrator-signed but off-contract operator authorization, appended raw by a signing-key holder, would count as a verified operator, and so as current authority in `verifyFvCurrentOperators`. Exploiting it needs both the store's signing key and an administrator assertion over an off-contract commitment. A sibling hotfix should bring it to the same parity before anything relies on operator roles.
- **The append guard** (`appendFvRevocation`) is defence in depth. It is reachable only by a write of the same owner between AUTH-03's verification and the append, and that path is tested (AUDIT-HF01).

### 17.8 Evidence

- **Tests.**
  - `tests/fv-p4c2b3c2a3a-credential-revocation.e2e.test.mjs`: 28 tests (4 added by AUDIT-HF01), with real child processes paused or SIGKILLed, a real witness and real AUTH-02 authentication.
  - `fv-p4c2b3c2a3a-credential-revocation-structure.test.ts`: 4 tests.
  - Existing structure pins gained exact, commented exceptions for the new family member. No assertion was removed.
- **Regression:** the focused suites (2A3A, 2A2B, 2A2A, HF01, 2A1, B3C-3, B3B, B3C-1, FV-EXEC-LOCK-01, all structure tests, AUTH-02/03/04, CORE-07, G-02A, PROD-02) and every gate pass on the final tree. The counts are in the CHANGELOG entry.
- **Targeted mutants: 20 of 24 killed** (including the publication review's exact-row check). They ran on the compiled code in a separate copy, and every file was restored and hash-checked.
  - **Killed:**
    - the administrator's current state;
    - Host revocation of an FV store;
    - an operator as the authority;
    - the organization binding;
    - target ownership;
    - the target's key digest;
    - the administrator's signature;
    - the counter;
    - the stale head;
    - the expired window;
    - the verifier's signature re-check;
    - the verifier's recorder check and its target-role re-check. Both were first classified redundant or unreachable, but the publication audit showed them reachable. A signing-key holder can append a *genuinely administrator-signed* revocation outside the ceremony, or of a principal that is no verified operator; without these checks the audit would label it authorized. Both are now tested;
    - current authority ignoring revocation;
    - an already-revoked credential;
    - revocation over an unfinished plan;
    - `revoked` without the witness readback;
    - the store fence;
    - bootstrap enabled.
  - **Surviving (4), each with its evidence against the final code:**
    - **The consumed-challenge check: C, unreachable.** The challenge derives from a commitment that includes the prior head, so it cannot already be in that history.
    - **The verifier's position check: B, redundant.** It is redundant with the chain-digest check; removing both is killed by the stale-approval test.
    - **The append guard: B, redundant.** The head is pinned by the verification, and the store is held exclusively.
    - **"The administrator is never a target": B, redundant.** The administrator never holds a verified operator role, so the target role check refuses first (tested).
- **Independent review** (a fresh read-only AI agent; **not a human review**). It found no authority bypass and no way to revive a revoked credential, and raised three Lows, all fixed and tested:
  - **L1:** a recorded intent's request id was not bound to its evidence. A record writer could re-file one request's evidence under another id; it now must match.
  - **L2:** the revocation verifier ignored `credential_revoked` rows from other recorders. Every such row on an FV store is now judged, and a row from another recorder counts as unauthorized.
  - **L3:** the verifier re-checked less than AUTH-03 did at write time. It now also re-checks the target's verified operator role, that the target is not the administrator, the active administrator principal, the challenge, the counter and the signed time.

  Info, documented in §17.6–§17.7: a recorded revocation goes stale if an enrolment lands first, and must be authorized again; a forged counter-raising row needs the signing key.
- **Publication review (PR #268, head `d2febb1c`; a fresh read-only AI agent, not human).** No authorization bypass.
  It reproduced two problems with the audit's integrity:
  - **F1, Medium:** a genuine authorization appended at its position with a swapped projected field (for example
    `assertedWith` moving the counter to another credential) was labelled authorized. **Fixed:** the stored row must
    equal the row AUTH-03 rebuilds. AUTH-03's remaining write-time checks are also re-checked. Tested, and the mutant
    is killed.
  - **F2, Low/Medium:** an authorization the ceremony refused as expired, appended later by a key holder, is labelled
    authorized. **Documented as a limit (§17.4):** there is no trusted append time to check against.
- **Post-merge review (PR #268 merged as `ccbeff0d`; a fresh read-only AI agent, not human)** found F-A, F-B and F-D. **AUDIT-HF01** closes or documents each:
  - **F-A, Low: fixed.** The audit did not re-check the deployment, state kind, witness id, witness key digest or 300 s cap. An administrator-signed but off-contract row was therefore labelled authorized. `verifyFvRevocations` now takes the registration's authenticated expectation (a required fourth argument), fails closed without a complete one, and re-checks all five.
    - The independent review of this hotfix (N1, Low, reproduced) found the store id unchecked too, against a doc claim that the chain digest binds it. It is now compared explicitly, and tested.
    - Tested on nine off-contract rows, each refused by AUTH-03 and reported unauthorized: a 30-day window, an inverted window, another store, deployment, state kind, witness id or witness key, a substituted target key, and a target credential owned by another principal. For the five scope cases, the same row is authorized under its own scope, which proves the scope check is what refuses it.
    - Controls: the raw row is shown to equal AUTH-03's row; an in-scope row, and one at exactly the 300 s cap, are authorized; a missing or incomplete scope authorizes nothing.
  - **F-B: documented** in §17.4 and §17.7. A test pins the retained limit.
  - **F-D: tested.** A write by the same owner, made between AUTH-03's verification and the guarded append, gives `CONFLICT`. Nothing is revoked, the history and witness stay consistent, and the operator keeps current authority.
  - **Mutants: 13 of 14 killed,** on the compiled audit in a separate copy, restored and hash-checked. They cover the lifetime cap and its positive bound, each of the five scope bindings, row equality, the signature, the target key digest, target ownership and the append guard (until now an untested survivor). The survivor is the explicit fail-closed scope guard, which is redundant: the strict parser requires every scope field of an authorization to be non-empty, so a missing or empty expectation never matches, and a null one throws inside the audit's `try`. It is kept as defence in depth.
  - **Found, not fixed:** the same class of gap in `verifyFvOperatorRoles` (§17.7).

## 18. B3C-2A3B: governance recovery and interrupted enrolment (design only; NOT implemented)

Nothing in this section exists in code. It is the design B3C-2A3B must implement and review.

### 18.1 Trust-anchor inventory

| Anchor | Today | Can it recover governance? |
|---|---|---|
| Registration issuer (pinned keys, G-02A) | Authorizes registration and the first administrator | **Yes, by design**, through a separate, narrowly scoped recovery capability. It must never become a general administrator |
| FV administrator credential | The sole administrative root | No; this is what is lost or compromised |
| Store signing key (CORE-02) | Signs every row | **No.** A store signature is not administrator consent; it is a trust root for integrity only |
| CORE-07 witness | Proves the current head | Proves state; grants nothing |
| Host administrators, FV operators, local configuration, the registration record | — | **Never** (no self-promotion) |

### 18.2 Threats and proposed answers

- **A. Lost administrator credential.** The registration issuer signs a single-use `…recover-administrator` capability. It is bound to:
  - the registration and store, and the current witnessed head;
  - the lost administrator's principal and credential;
  - a new administrator candidate, who proves possession first, as in 2A2A.

  AUTH-03 appends a revocation of the old administrator credential and a new administrator credential row. A new rule recognizes **one** current administrator credential, the latest issuer-authorized one. That is required: today "administrator" means the sequence-1 row.

  Acceptance: no FV operator or Host administrator can do this; a stale-head capability is refused; the old credential authorizes nothing afterwards; a replay is refused.
- **B. Compromised administrator credential.** The holder of a compromised credential cannot be trusted to authorize its own revocation, so:
  - **Suspension:** an issuer-signed `…suspend-administrator` capability appends a revocation row for that credential. Every authorization then fails closed.
  - **Replacement:** follows A.

  Open question for review: whether a quorum of verified operators could co-sign a suspension (*not* a promotion). The default is no.
- **C. Mid-plan lockout (§16.7).** An issuer-signed `…abandon-enrolment` capability is bound to the unfinished plan's commitment and the witnessed head. It appends a signed abandonment row that closes the plan, so the detector treats it as finished and its principal as never enrolled. It covers:
  - a lost or corrupted progress record;
  - a changed relying-party origin, deployment binding or witness key;
  - an unusable administrator credential;
  - a forged but consistent plan start.

  There is never a `--force`, `--reset` or `--adopt`. Acceptance: the abandoned principal has no role and no credential; a resume of the abandoned plan is refused; AUTH-02 writes resume.
- **D. A lost CORE-07 prepare answer.** Recovery must first prove the state from the independently trusted witness. Either:
  - the witness holds a prepared successor the store lacks: the local commit was lost, so the local history is authoritative and the witness pending entry is resolved by an issuer-signed, witness-verified **abort** of that pending entry; or
  - the store holds it: CORE-07 already finalizes.

  This needs a CORE-07 witness operation reviewed on its own. Restoring a store from backup is B3C-2B/2C, and independent continuity is FV-P4D: out of scope.
- **E. Issuer anchoring of the first administrator.** Today the administrator's credential is anchored only by the store signing key: row 1 pins the plan digest, but the issuer signed only the person, not the key. 2A3B should either:
  - re-verify the 2A2A intent's issuer-signed capability plus the attestation from the registration record, and pin the record's intent digest in a witnessed row; or
  - require a resume-style issuer confirmation of the credential digest.

  Either way, *store-signature validity* stays separate from *administrator consent*.

### 18.3 State machine (proposed)

```
FV store:   EMPTY ─(2A2A, issuer)→ ADMINISTERED ─(2A2B, admin)→ ADMINISTERED+OPERATORS
                                        │                    │ (2A3A, admin) operator credential REVOKED
                                        │ (2A3B, issuer) administrator SUSPENDED ─(2A3B, issuer)→ RE-ADMINISTERED
            MID-PLAN ─(resume)→ ADMINISTERED+OPERATORS
            MID-PLAN ─(2A3B, issuer abandon)→ ADMINISTERED+OPERATORS (plan closed, principal inert)
            PENDING-RECOVERY (CORE-07) ─(2A3B, issuer + witness proof)→ previous state
```

### 18.4 Acceptance gates for 2A3B

- **Real processes and a real witness:** SIGKILL at each new row, and a lost prepare or finalize for each.
- **Mutants:** every issuer check, head binding and single-use rule is killed.
- **Refused attempts:** recovery by an operator, a Host administrator, the store key alone, the record alone, or a stale capability.
- **Containment:** a compromised administrator credential can be suspended without its holder's cooperation, and the suspension holds across rollback (witness).
- **Abandonment:** an abandoned plan's principal has no authority.
- **Review:** independent review, then human security review of the new issuer powers.

**Dependencies:** B3C-2B/2C (backup and restore of the store, record and ledger), FV-P4D (continuity independent of the witness's restore domain), and a production issuer in custody (G-02B). None is implemented here.

## 19. B3C-2A1-RACE-INV-01: registration record publication and lock acquisition (post-merge investigation)

**Incident.** CI on main `cded5c80` (`protocol-tarball-consumption`) failed the B3C-2A1 test "one capability, two processes at once". One process got `REGISTRAR_BUSY`, the other `RECORD_CORRUPT`, and neither registered. The same test passed on the PR head and locally. This was not caused by PR #269, which touches no registration code.

**Root cause: two implementation defects in opening the registration record** (`identity-registration-record.ts`). Both reproduced against the real code.

- **D1: the record was visible before it existed.** A new record was created with `O_EXCL` *at its final path*, and only then locked and initialized. Another ceremony that started in that window saw an existing file and could:
  - take the lock first and find no record in it (`RECORD_CORRUPT`; the CI pair, with the creator then refused `REGISTRAR_BUSY`);
  - or tie with the creator (D2).

  Either way, and equally after a crash in that window, the uninitialized file stayed at the record path. Every later registration then refused it as `RECORD_CORRUPT`, because a file at the record path is never initialized in place. Nothing was consumed (no ledger, no store, an unbound witness slot), but the deployment could not register again without operator action.
- **D2: a lock with no single winner.** The lock was taken with exclusive locking mode already set and `busy_timeout = 0`. Two openers both took SQLite's SHARED lock, neither could escalate, and both were refused.

**Evidence before the fix** (real processes, bounded):
- Deterministic reproductions:
  - an empty record file (what the creator's `O_EXCL` leaves) makes a real registrar refuse `RECORD_CORRUPT`, as does every retry;
  - the real opener creates the file, loses the lock in its window to another holder (`BUSY`), and leaves the file behind.
- Unmodified two-process races: both refused in 2 of 20 runs on a new record, each leaving a 0-byte file, and in 5 of 20 on an existing one.

**Fix** (narrow; authorization, ledger, witness and store logic unchanged):
- **D1.** A new record is initialized in full under a private, owner-only, `O_EXCL` name beside the record path (`<record>.init-<random>`), made durable, and published with `link`, which never replaces anything. The private name is then removed. A ceremony that publishes second simply opens the first one's record. The record path therefore only ever holds a complete record.
  - An interrupted publication leaves at most an unused private file, which is not at the record path, or, if killed between `link` and the removal, a second name of the record (`LINKED`). The registrar and the opener release exactly such a name: the publication pattern, and the same file. No content changes, and the record is verified as always.
  - Anything else at the record path stays refused, never adopted: an empty or table-less file (`RECORD_CORRUPT`), or another second name (`PATH_REFUSED`).
- **D2.** The lock is acquired in normal locking mode with a bounded wait (500 ms), so a failed attempt releases what it took and one contender acquires. Exclusive mode is then set while the lock is held, so it is kept for the whole ceremony. A record held by a running ceremony is still refused (`REGISTRAR_BUSY`) once the wait ends. Every opener of the record (registration, its resume, the FV ceremonies and the verification) may wait up to 500 ms before that refusal.

**Evidence after the fix:**
- The same unmodified races ran 40 + 40 times with a single winner every time; the loser got `REGISTRAR_BUSY` or `ALREADY_REGISTERED`. No ties, no corrupt record.
- **As merged in PR #271** (squash `b51df3d2`, identical in tree to the reviewed head `1566970e`): `tests/fv-p4c2b3c2a1-race-inv01-record-publication.e2e.test.mjs` with 6 tests, all using real, separate processes (POSIX locks belong to a whole process):
  - publication is complete, with nothing at the record path meanwhile;
  - two contenders, started together while a third process holds the record, give exactly one prompt winner;
  - an opener waiting for the lock holds nothing, so a writer holding RESERVED can still commit. This test is timing-dependent: it assumes the opener entered its wait within 100 ms;
  - the wait is bounded;
  - both interrupted-publication states recover;
  - everything else stays refused.

  On the pre-fix implementation (the `cded5c80` sources, rebuilt), 5 of the 6 fail. The sixth pins the never-adopt guard and passes on both, by design.

  Mutants executed for #271, all killed:
  - no wait;
  - exclusive mode set before acquiring;
  - publication release disabled;
  - the registrar's release removed.

  The opener's L1 re-check (added in #271's second commit) **had no regression test in #271**.
- **Post-merge follow-up (RACE-INV-01-TEST-HF01; tests and documentation only, a separate PR; not part of #271's squash).** It adds:
  - **L1:** a record seen `LINKED` while a live publication removes its own private name is re-checked and opened. The instant is deterministic: the "publisher" removes the name during the release's directory scan.
  - **The re-check adopts nothing:** a foreign second name; a private-pattern file of another inode (kept, inode unchanged); a real publication name beside a foreign-inode pattern file (only the publication's name is released, the record opens, and the other file is untouched); a symlink; another organization's record; a schema-less file.
  - **Monotonic timing:** every elapsed-time measurement uses `performance.now()` in the measuring process, with no cross-process wall-clock comparison, after a wall clock was seen stepping backwards on WSL. The thresholds are unchanged.

  The file now has 8 tests.
- **Mutation evidence, by kind** (all on the compiled code in an isolated copy, restored and verified identical):

  | Mutation | Detected by | Result |
  |---|---|---|
  | No wait | E2E, deterministic | Killed |
  | Publication release disabled | E2E, deterministic | Killed |
  | Registrar's release removed | E2E, deterministic | Killed |
  | Opener's L1 re-check reverted | The L1 E2E test, deterministic | Killed in every run (4 of 4 for #271's follow-up review, 4 of 4 here); fails with exactly the pre-fix `PATH_REFUSED (LINKED)` |
  | Release's same-inode check bypassed | The adopts-nothing E2E test, deterministic | Killed in every run (4 of 4) |
  | Exclusive mode set before acquiring | **Structural pin:** every time. **Timing-dependent E2E** (lock-order test): 6 of 6 runs. The two-contender test alone: about 2 of 3 | Killed |

  That is 6 distinct mutations, executed as 7 runs: the lock-order mutation runs once against the lock-order test alone and once against the contention tests. All 7 runs were killed.
- **Independent review** (a fresh AI agent, not human): conditional go. It confirmed both D2 halves are needed (both refused in 17–21 of 25 runs for each half alone, 0 of 25 with both) and that SIGKILL during publication is recoverable (60 of 60 on the fix; 14 of 30 kills left a permanently corrupt record on the pre-fix code). Its three Lows were addressed:
  - the mutant wording above;
  - a start-skew flake risk in the contention test: contenders now start on one signal, and the winner's promptness is measured from the reader's release;
  - the registrar's release helper could throw: it now never throws, and the file policy refuses whatever it could not release.

**Limits:**
- **Existing deployments that already hit D1** keep a schema-less file at the record path and stay `RECORD_CORRUPT`. The fix never adopts, deletes or resets it, and the product has no recovery mechanism for it.

  Removing such a file is an operator decision, reviewed by a second person, and only on independent evidence of **all** of:
  - the deployment and organization the path belongs to (its exact registered scope, from the registrar's configuration);
  - the file holds no tables and no authority state;
  - no capability was consumed: no ledger file, or no claim for that registration in it;
  - the witness's FV slot for that organization is unbound (read from the witness, not inferred);
  - no live registrar or other process holds or uses the path;
  - no signed identity history (FV store) exists for that organization anywhere.

  If any of these cannot be established, the file stays and the deployment stays refused.
- **Unused private files** left by a crash before publication are inert and are not removed automatically.
- **Durability against power loss is not proven by these tests.** They prove consistency under process death (SIGKILL). For power loss, the design relies on the operating system and filesystem honouring `fsync`:
  - the private file is fsynced before `link`;
  - the directory is fsynced after publication.

  A lost `link` leaves no record (a later registration publishes anew), and a lost removal leaves the second name that is released. The order was checked by reading the code, not tested, and a filesystem that ignores `fsync` voids it.
- **Publication review (PR #271; a fresh AI agent, not human): GO.** Findings:
  - **L1, Low, fixed:** an opener or the registrar that saw `LINKED` during a live publication's `link`→removal instant was refused `PATH_REFUSED` if the publisher removed its name first. Both now re-check after any `LINKED`.
  - **Wording:** the lock-order test is timing-dependent, not deterministic. Now stated.
  - **L2, Low, pre-existing, not fixed here:** two ceremonies in **one process** can drop each other's POSIX lock. `walHeader`'s raw open and close on a record held in the same process is enough. It fails closed (fence, exit guard). It belongs in a follow-up, for example a module-level in-process mutex.
- **`link` is required:** on a filesystem without hard links, creating a record is refused (`RECORD_UNAVAILABLE`).
- **Liveness, not mutual exclusion,** still depends on the bounded wait. Under extreme scheduling delay, both contenders can still be refused `REGISTRAR_BUSY`. That outcome is recoverable: the record is complete and a retry registers.
