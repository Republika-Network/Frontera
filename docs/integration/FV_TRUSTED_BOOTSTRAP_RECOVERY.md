# FV-P4C-2B1 — trusted bootstrap and recovery of a sovereign status history

**Status:** a foundation, not an operational workflow. The contracts are proposed and versioned, the
coordinator is implemented and tested with synthetic providers, and nothing is composed into the Host:
there is no endpoint, no CLI, no reset and no production bootstrap. Nothing here changes an ASSURE
contract, CORE-07, Soberanía or the receiver package.

A receiver's status history (FV-P4C-1 gate, FV-P4C-2A SQLite store) protects against replay only
relative to what it has trusted. **Bootstrap** is the one point where trust enters it. This document
defines who may do that, on what basis, how it is recorded, and what recovery is and is not allowed.

## Implemented and proposed

**Implemented** in `src/enterprise/sovereign-status-history/`:

| API | What it is |
|---|---|
| `parseStatusHistoryBootstrapRequest` | Closed validator for `frontera.sovereign-status-bootstrap/1` |
| `bootstrapBindingOf`, `bootstrapBindingDigest` | The exact binding an authorizer decides on, and its SHA-256 |
| `parseStatusHistoryBootstrapEvidence` | Closed validator for `frontera.sovereign-status-bootstrap-evidence/1` |
| `coordinateStatusHistoryBootstrap(request, signedStatusText, context)` | The fail-closed coordinator |
| `StatusHistoryBootstrapAuthorizer`, `StatusSourceVerifier` | Injected provider interfaces; no implementation is shipped |
| SQLite store schema **v2** | Bootstrap evidence ledger in the same file, plus the methods `compareAndSetWithEvidence`, `hasBootstrapRequest` and `readBootstrapEvidence` |

**Proposed, for FV-P4C-2B2:**
- an authorizer backed by the Host's existing authority services;
- composition of the coordinator and the store into the Host;
- backup and restore registration.

**Proposed, for FV-P4D:**
- an external current-state witness;
- R3 recovery.

**Store v2 changes 2A behaviour, deliberately.** An ordinary `compareAndSet` can no longer create a
history, or change its anchor. A v1 file is refused rather than migrated: v1 was never composed, and
inventing evidence for histories that have none would misstate how they were anchored.

## 1. Trust model

The invariants this foundation enforces:

| | Invariant | Where it is enforced |
|---|---|---|
| S1 | A valid signed status never initializes a history by itself | Coordinator (all checks) and store (no history without evidence) |
| S2 | A failed read, a missing file or corrupt history never triggers a clean initialization | Store throws; the coordinator refuses with `HISTORY_STORE_UNAVAILABLE` |
| S3 | A latched conflict is never cleared | Coordinator pre-check, receiver `establishStatusHistory`, store (twice) |
| S4 | A withdrawal is terminal | Receiver re-anchor rules and store triggers |
| S5 | Retired terms stay retired | Receiver re-anchor rules and store triggers |
| S6 | No downgrade of sequence or time floor | Receiver re-anchor rules and store (adapter and triggers) |
| S7 | Evidence or a request is never authority | Authority only from the injected authorizer, bound to the exact binding digest |
| S8 | No global freshness claim | The source class is recorded; nothing claims more than the source proves |
| S9 | No execution | Every result reports `documentAuthorization: 'not_evaluated'` and `execution: 'not_performed'` |

## 2. Operator authorization

**What the Host has today** (read, not changed):
- **AUTH-02:** human principals with passkey credentials (`human-identity`).
- **AUTH-03:** decision-bound human authority (`decision-challenge`).
- **CORE-05:** approval authority with subject-bound approvals (`approval-authority`).
- **CORE-02:** authority signatures (`authority-authenticity`).

None of them has a subject kind for "anchor this status history". Composing one is a Host change, out
of scope here. FV-P4C-2B1 therefore defines only the interface, and refuses everything that does not go
through it.

| Duty | Required identity and authority | In FV-P4C-2B1 |
|---|---|---|
| Bootstrap requester | Named by `operatorRef`. Only an identifier, never a credential | Request field; authenticated by the authorizer, not by the coordinator |
| Bootstrap authority | A decision on the exact binding, from the Host's authority (AUTH-03 or CORE-05 in 2B2) | `StatusHistoryBootstrapAuthorizer`; only `{outcome:'authorized', bindingDigest, authorityRef}` with this binding's digest is accepted |
| Status-source verifier | The Host's trusted source integration | `StatusSourceVerifier`; its answer is checked against the host's `StatusSourcePolicy` |
| History store operator | The Host process owning the store file | The store; refuses everything that is not a valid transition with evidence |
| Evidence recorder | The store, in the same transaction | `compareAndSetWithEvidence` |
| Independent evidence reviewer | ASSURE, later | Reads `readBootstrapEvidence`; the record is unsigned (see §6) |

For v1, the smallest credible arrangement:
- **Authority:** the authorizer is an AUTH-03 decision-bound human approval over the binding digest.
- **Separation of duties:** the approver is not the requester (the binding names the requester).
- **Revocation:** credential revocation is handled by the authority service. A revoked or unavailable
  authority refuses (`OPERATOR_UNAUTHORIZED` / `AUTHORITY_UNAVAILABLE`).

Separation of duties is the authorizer's to enforce. The coordinator cannot tell two principals apart.

**FV-P4C-2B2:** `createHumanDecisionBootstrapAuthorizer` implements this arrangement over AUTH-03 passkey
decisions (requester ≠ approver, both bound to the binding digest). It is tested against the real
identity service and is not composed: see `FV_HOST_AUTHORITY_INTEGRATION.md` for the blockers.

## 3. Source currentness policy

A bootstrap trusts one signed status. That status may already be obsolete, so the host must also have a
statement of currentness from a source its policy accepts.

| Class | Who controls it | What it can show | What it cannot show |
|---|---|---|---|
| `issuer-status-channel` | The registrant | The registrant's own latest status | That the registrant is not withholding a newer one |
| `receiver-trusted-registry` | A registry the receiver trusts | The registry's latest, as of its last update | Anything newer than the registry saw |
| `current-state-witness` | An independent witness answering a fresh challenge (FV-P4D) | Currentness at the witness, bounded by its challenge | Updates never published to the witness |
| `anchored-checkpoint` | This receiver, earlier | No regression below the checkpoint | Currentness |
| `manual-out-of-band` | A person | What that person verified | Anything auditable beyond their statement. It is accepted only when policy names it, and recorded as such |

Rules applied by the coordinator:
- Every attestation's class must be in the policy.
- `observedAt` must not be in the future, and must be no older than `maxSourceAgeSeconds` (1–86 400).
- All attestations must agree.
- The agreed status must be exactly the requested one. If it is newer, the request is refused as
  `SOURCE_REPORTS_NEWER`.

Retrieving a status over HTTPS is not proof of currentness. Access to Fileverse is not authority over a
status.

**Limitation.** A source that withholds a newer status and attests the old one is believed. The
evidence names the source, so the claim can be audited later, but it cannot be detected now.

## 4. Bootstrap state machine

The coordinator is one function call. Its states are not persisted. Only `ESTABLISHED` leaves a trace,
and it leaves both the history and its evidence atomically. Any check that fails ends in `REJECTED`
with a closed reason.

```
UNINITIALIZED / ESTABLISHED (reanchor)
  → REQUEST_VALID        form, lifetime ≤ 900 s, not yet valid / expired, namespace, subject, unused request id
  → HISTORY_ADMISSIBLE   reanchor needs a history; a latched conflict is CONFLICT_LOCKED (refused before authority is asked)
  → STATUS_VERIFIED      FV-P4B verification, exactly the requested sequence, digest and terms
  → AUTHORITY_VERIFIED   the authorizer's decision names this binding's digest
  → SOURCE_VERIFIED      the policy-accepted, recent, unanimous source names this status as latest
  → COMMITTED            the receiver's establishStatusHistory accepts the transition; mark and evidence in one transaction
  → ESTABLISHED
```

| Case | Result |
|---|---|
| New database, no history | `UNINITIALIZED`; the gate refuses every action until a bootstrap |
| Valid request, unauthorized operator | `OPERATOR_UNAUTHORIZED` |
| Authorized operator, invalid status | `STATUS_REJECTED` / `STATUS_MISMATCH` |
| Valid status, untrusted source | `SOURCE_UNTRUSTED` / `SOURCE_STALE` |
| Authorized operator, obsolete status | `SOURCE_REPORTS_NEWER` when the source knows; otherwise undetectable (see §3) |
| Valid status, trusted source | `ESTABLISHED` / `REESTABLISHED` |
| Repeated request | `REQUEST_REPLAYED` (one use per store) |
| Concurrent bootstraps | Exactly one commits; the others are refused |
| Bootstrap against an existing history | `HISTORY_REFUSED` / `ALREADY_ESTABLISHED` |
| Bootstrap against a conflict | `HISTORY_REFUSED` / `CONFLICT_DETECTED` |
| Re-anchor after withdrawn | `HISTORY_REFUSED` / `REANCHOR_REACTIVATES_WITHDRAWN` |
| Re-anchor onto retired terms | `HISTORY_REFUSED` / `REANCHOR_REINTRODUCES_RETIRED_TERMS` |
| Missing or corrupt evidence | `HISTORY_STORE_UNAVAILABLE`, and the gate quarantines the history (R2) |
| Database restored from an old copy | **Not detectable** (§10) |
| Evidence ledger restored from an old copy | The ledger and history live in one file and are restored together. They stay consistent with each other, so this is **not detectable** either |

## 5. Recovery classification

| Class | Situation | Action in FV-P4C-2B1 |
|---|---|---|
| **R0** | Ordinary restart, history intact | Reopen; open checks (schema, triggers, integrity) and row validation |
| **R1** | Interrupted transaction | SQLite rolls back; nothing partial is visible. No conflict is cleared |
| **R2** | History or evidence missing, corrupt, unsupported (a v1 file included) or inconsistent | Fail closed. The gate reports `HISTORY_STORE_UNAVAILABLE` and bootstrap is refused. Nothing is deleted or re-initialized, and a refused file is left untouched. **Do not delete or replace an incompatible or damaged history file:** an empty one would forget every status it saw. The operator's only safe option is out-of-band investigation |
| **R3** | Latched conflict, or external evidence contradicting local history | Fail closed. **No R3 recovery exists.** It needs a separate governance procedure with stronger proof (FV-P4D or later) |

The only recovery operation is `reanchor`. It restores continuity after a sequence gap, under every rule
in §1. There is no `resetHistory`, no `clearConflict`, no `forceBootstrap` and no option that bypasses a
check.

## 6. Evidence contract

`frontera.sovereign-status-bootstrap-evidence/1` has the following fields. The store fills in
`previous`, `next` and `reason` from the state it replaced.

| Field | Content | Confidentiality |
|---|---|---|
| `schemaVersion`, `classification: 'host-recorded-unsigned'`, `result: 'committed'` | Format and nature | Public |
| `operationId`, `requestId` | Host operation and request identifiers | Public if the Host's identifiers are |
| `namespace` | Receiver history namespace | Only if non-sensitive |
| `sovereignAssetId`, `issuer` | The history | Identifiers, not content. Disclosure to third parties is ASSURE's decision |
| `operation`, `purpose` | Closed values | Public |
| `bindingDigest` | SHA-256 of the authorized binding | Public |
| `operatorRef`, `authorityRef` | Who asked; which decision authorized | Internal references; never credentials |
| `sources[]` | Class, reference and observation time of each attestation | Public; secret-bearing references are refused |
| `status` | Sequence and digest anchored | Public |
| `previous` / `next` | Revision, sequence and digest before and after | Public |
| `evaluationTime`, `reason` | The trusted instant, and `ESTABLISHED` or `REESTABLISHED` | Public |

Never present: document content, private keys, decryption URLs or `#key=` fragments, credentials, tokens,
e-mail-as-credential, or filesystem paths. The validators refuse references that look like URLs carrying
credentials or key fragments.

**Integrity.** The record is unsigned. Frontera has authority signatures (CORE-02) and an unsigned event
digest chain, but no evidence-signing mechanism for this record, and no new signature protocol is
invented here.
- **Protected:** triggers make the ledger append-only, so a record cannot be deleted or rewritten
  through SQL.
- **Detected:** a history whose latest evidence is missing or does not match its anchor is refused.
- **Not detected:** a forged but well-formed `authorityRef` written by someone with raw file access.

It is evidence that **Frontera recorded**, not an independent attestation.

## 7. Atomicity

A same-database ledger is practical, so it is used. `compareAndSetWithEvidence` writes the mark and the
evidence row in **one** `BEGIN IMMEDIATE` transaction:
- a failure in either half rolls back both;
- a lost compare-and-set writes neither;
- a request id can be recorded only once.

No prepare, commit or reconcile protocol is needed, and no atomicity is claimed across files.

## 8. Fail-closed behaviour

- Every stage has a closed reason (`STATUS_HISTORY_BOOTSTRAP_REASONS`).
- A throwing provider is "unavailable", never "authorized" or "current".
- An unreadable history is never empty.
- A commit without the expected outcome, or the reverse, is never reported as success.
- **Commits are confirmed, not believed.** After the receiver reports `established`, the coordinator
  re-reads the store, and refuses with `COMMIT_UNVERIFIED` unless all of these hold:
  - the store returned the evidence of this very draft;
  - the request id is recorded;
  - the history carries this anchor, at or past the recorded transition.

  The coordinator then reports a refusal even if something was written.

**Trust assumptions about injected components.** The receiver functions, the store, the authorizer and
the source verifier are the Host's own, composed by trusted code, never supplied by a request.
- **What the coordinator detects:** an implementation that fails, misreports one step, or returns
  inconsistent answers.
- **What it cannot detect:** a malicious implementation inside the Host process that lies consistently.
  No such resistance is claimed.

## 9. Threat model

Each threat below is covered by tests in `tests/fv-p4c2b1-trusted-bootstrap.e2e.test.mjs` and
`src/enterprise/__tests__/fv-p4c2a-sqlite-status-history.test.ts`.

| Threat | Defence | Residual |
|---|---|---|
| Unauthorized or revoked operator | Injected authorizer only | Depends on the authorizer (2B2) |
| `approved: true`, a role, or a look-alike answer | Closed request, context and decision shapes | — |
| Replayed authorization | Decision must name this binding's digest | — |
| Replayed request | One use per store; unique at the SQL level | Across stores, a request is bound to its namespace |
| Old status, untrusted, stale or conflicting source | Source policy | Withholding source (§3) |
| Wrong asset, issuer, manifest, namespace or status | Bound to the host-verified subject and the store's namespace | — |
| Concurrent bootstraps | `IMMEDIATE` transaction, CAS and unique request id | — |
| Conflict, withdrawal, retired terms, downgrade | Receiver rules, store adapter and triggers | — |
| Corrupt or missing history or evidence | R2 quarantine | — |
| Forged evidence row | Fails validation, and grants nothing on its own | Well-formed forgery with raw file access |
| Malicious timestamps | Host trusted clock; request lifetime ≤ 900 s; no future source | The host's clock is trusted |
| Whole-file restore or deletion | — | **Not detected** (§10) |

## 10. Known limitations

- **Restore and deletion.** A whole-file restore or deletion of the store, ledger included, is not
  detectable. It needs an external anchor (FV-P4D).
- **Withholding sources.** A source that withholds a newer status and attests the old one is believed.
- **Unsigned evidence.** It is not independently attested.
- **No authority implementation.** There is none yet. Separation of duties is the authorizer's to
  enforce.
- **No R3 recovery.** A conflicted history stays refused.
- **Trusted clock.** The host's clock is trusted.

## 11. ASSURE handoff

| Evidence | Produced by | Verifiable by |
|---|---|---|
| The bootstrap evidence record | Frontera (host-recorded, unsigned) | Re-reading the ledger; consistency with the history |
| The anchored status | The registrant (signed) | Anyone with the registrant's pinned key, using Soberanía's primitives |
| The authority decision | The Host's authorizer (2B2) | Depends on that authority's own evidence (for example AUTH-03) |
| The currentness statement | The status source | Only as far as the source authenticates it; recorded by class |
| External witness | — | Not available (FV-P4D) |
| Reproduction | Re-running FV-P4B verification on the anchored status | Independently, by anyone holding the status and the key |

Open items for ASSURE:
1. Signing or attesting the bootstrap evidence record.
2. Joining it with the authority's own evidence.
3. Confidentiality of `namespace`, `operatorRef` and `authorityRef`.

No certification or conformity claim is made.

## 12. Dependencies

- **FV-P4C-2B2:**
  - an authorizer over the Host's existing authority (AUTH-03 decision-bound approval, or a CORE-05
    subject kind);
  - a source verifier for the policy's classes;
  - composition into the Host, with no request-reachable path;
  - store registration for backup and restore.
- **FV-P4D:**
  - an external anchor for the store (against whole-file restore and deletion);
  - a current-state witness;
  - a governed R3 procedure.
