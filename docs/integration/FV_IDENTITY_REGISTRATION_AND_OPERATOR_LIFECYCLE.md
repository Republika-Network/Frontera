# FV-P4C-2B3C-2A — FV identity registration and operator lifecycle

**Status: internal and non-operational. Not production-ready. Production activation: NO-GO.**
- Nothing in the Host, its scripts, its deployment, the dedicated executor or its supervisor invokes the
  registration ceremony (structure tests pin this). The production executor entry still composes nothing.
- No production issuer of a registration capability exists; issuance in this repository is test-only.
- Bootstrap execution stays disabled: there is no trusted status source (B6).

**Split (§15 of the increment prompt).** This increment implements **B3C-2A1** only: durable registration
authority, genesis, the store-id pin and its verification by the executor. **B3C-2A2** (FV operator
enrolment) and **B3C-2A3** (operator revocation and governance recovery) are **design only** (§10–§11).
No FV operator can be enrolled or revoked by anything in this increment.

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

## 10. B3C-2A2 — FV operator enrolment (design only; not implemented)

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

## 11. B3C-2A3 — revocation and governance recovery (design only; not implemented)

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
- B3C-2A2 and B3C-2A3;
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
  organization. A claim the ledger then refuses appends `capability-claim-refused`.
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
- A completed resume also settles the register claim its record's row holds. Before, a crash left that claim
  `claimed`.

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
- this ceremony dying before it records the refusal.

Only then may this record later settle the other record's claim `failed`. That is bookkeeping only: nothing
is reopened, consumed twice or created, and no ceremony decision reads the state.

### 14.3 Evidence

- **Tests:** `tests/fv-p4c2b3c2a1-hf01-witness-ledger-isolation.e2e.test.mjs` (15 tests), using real witnesses,
  stores, verifier and ledger, and real child processes paused or killed at durable steps. They cover:
  - each misrouting, from both steps, including a persistent misrouting during resume;
  - another key and a replayed answer;
  - an authoritative contradiction, using a witness of the same identity and key whose slot binds another
    store: quarantined;
  - each organization in flight while the other registers, in both orders;
  - the same organization's other deployment;
  - a crash after the intent;
  - both organizations orphaned, then retrying concurrently in separate processes;
  - a refused claim;
  - a cross-organization capability.

  On the merged code, 13 of the 15 fail. The two that pass (another key or a replayed answer; a cross-organization
  capability) pin behavior that was already correct.
- **Targeted mutants:** run on the final code, on the compiled code in a separate copy, with every file restored
  and hash-checked. Ten of eleven single mutants are killed, and the remaining one is killed in combination
  (below). Killed:
  - removing the confirmation;
  - treating a confirmed conflict as pending;
  - accepting a receipt with the wrong binding (in `witness-client`);
  - ignoring the state kind (in `sameBinding`);
  - the pre-fix cleanup rule;
  - assuming ownership while keeping the organization check;
  - not settling the register claim on resume;
  - no orphan settlement;
  - quarantining when the confirming read is unreadable.
- **Redundant layers:** not recording a refused claim (H07) and removing the pre-claim ledger check (H11) each
  survive alone, because each covers the other for a consumed capability. Removing both is killed by the
  refused-claim test.
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
