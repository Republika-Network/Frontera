# FV-P4C-2B2 — Host authority for trusted status-history bootstrap

**Status:** an authority adapter core, tested against the **real** AUTH-03 identity service, and a
design with explicit blockers.
- **Not composed:** no Host composition, store registration, backup coverage, restore handling,
  route, CLI or production bootstrap exists.
- **Unchanged:** ASSURE, CORE-07, Soberanía and the receiver package.

It continues `FV_TRUSTED_BOOTSTRAP_RECOVERY.md` (FV-P4C-2B1).

## Implemented and proposed

**Implemented:**
- **`createHumanDecisionBootstrapAuthorizer`**, in
  `src/enterprise/sovereign-status-history/human-decision-authorizer.ts`. It is a
  `StatusHistoryBootstrapAuthorizer` over AUTH-03 passkey decisions, with requester and approver
  separation.
- **`bootstrapHumanDecisionInputs(bindingDigest)`.** It gives the AUTH-03 decision inputs that bind a
  decision to one bootstrap.
- **Tests against the real AUTH-03 service.** They use software passkey authenticators, single-use
  challenges, revocation and expiry. The FV-P4C-2B2 end-to-end test drives the coordinator, the
  receiver package and a SQLite history under that real authority.

**Proposed, blocked on decisions B1–B6 below:**
- Host composition;
- the permission vocabulary;
- a trusted status-source adapter;
- store registration, backup and restore;
- restore quarantine.

## 1. Host authority inventory

All of the following were read, not changed.

| Service | Real API (used or relevant) | What it provides |
|---|---|---|
| AUTH-02 `human-identity` | `createHumanIdentityService(options)`; `HumanPrincipal { operatorId, actorRef: 'operator:<id>', state }`; passkeys with `userVerification: 'required'`; `revokePrincipal`, `revokeCredential` | Who a human is. Its contract states: "evidence of *who*, never of *may*" |
| AUTH-03 decision challenge | `beginDecision({ operatorId, approvalRequestId, subjectDigest: 'sha256:<hex>', verdict: 'approve'\|'reject' })`, `peekDecision(response)`, `authorizeDecision(response)` → `{ contract, commitment, evidence, evidenceDigest }` | A passkey signature over a canonical contract binding the organization, request id, subject digest, verdict, operator, nonce and a validity of at most 120 s. Single use: consumption is one signed, chained, witnessed append. Credential and principal must be active at consumption |
| CORE-05 `approval-authority` | `assess(...)` opens requests only for Kernel `approval_required` decisions; the subject is `frontera.approval-subject.v1`, built only from a Kernel evaluation | Four-eyes approvals, segregation of duties, quorum, expiry and revocation, but **only** for governed actions |
| CORE-02 `authority-authenticity` | `AuthorityArtifactKind`, a closed union of 8 signing domains | Signed artifacts. A new kind is a contract change |
| CTRL-02 `operator-control/roles` | `OPERATOR_PERMISSIONS` (closed), `operatorMay(role, permission)` | Operator standing. `authority.bootstrap` already means *organization* bootstrap (trust domains, root issuers) |

## 2. Integration decision

| Option | Verdict |
|---|---|
| A. AUTH-03 directly | It type-checks, but the CORE-05 passkey channel admits only pending CORE-05 requests, so A collapses into C |
| B. CORE-05 with a supported subject kind | **Not possible without misuse.** There is no subject-kind union: a subject comes only from a Kernel `approval_required` decision under a governance profile, and the store's `append` is not exposed |
| **C. A narrow internal adapter over AUTH-03** | **Selected.** It needs no change to a closed type: it calls the identity service's public decision methods through a structural port |
| D. Stop | Not needed for the adapter core. **Composition** is blocked (B1–B6) |

## 3. The authorizer (implemented)

One authorizer authorizes one bootstrap, from two passkey decisions the Host collected for it.
- **Binding.** The binding digest must be the coordinator's own SHA-256 over the 2B1 binding
  (`bootstrapBindingDigest`); there is no second algorithm. Each AUTH-03 decision must have:
  - `approvalRequestId = 'frontera.sovereign-status-bootstrap:<bindingDigest>'`, which is never a
    CORE-05 request id;
  - `subjectDigest = 'sha256:<bindingDigest>'`;
  - `verdict = 'approve'`;
  - the Host organization, and AUTH-03's own challenge format.
- **What that bars.** Since the digest covers namespace, asset, issuer, manifest, terms, status,
  operation, purpose, request id, operator reference and expiry, a decision cannot be moved to anything
  else.
- **Separation of duties.**
  - The requester's decision must belong to the request's `operatorRef`, as `operator:<operatorId>`.
  - The approver must be a **different** principal, with a different decision.
  - Each must hold the Host permission the injected `BootstrapHumanPermissions` names.
- **Peek before consume.** Both decisions are only peeked until every check passes, so a CORE-05
  decision, or a decision for another bootstrap, is never consumed by mistake. Each is then consumed by
  AUTH-03's `authorizeDecision`, which checks the passkey assertion, user verification, an active
  credential and principal, expiry and single use. The consumed contract must equal the peeked one.
- **Result.**
  - On success: `{ outcome: 'authorized', bindingDigest, authorityRef: 'frontera.human-decision:<requester commitment>:<approver commitment>' }`.
    Both commitments name `decision_authorized` rows in AUTH-03's signed chain.
  - On failure: `{ outcome: 'denied' }` with one closed reason (`lastDenial()`).
  - The authorizer is single-use.
- **Consumption is not atomic across the two decisions.** AUTH-03 consumes each decision in its own
  signed append: the requester's first, then the approver's. If the approver's is refused at that point
  (expired, revoked, already used, a bad assertion):
  - the requester's decision **stays consumed** in AUTH-03's chain;
  - the bootstrap is **denied**, and nothing is anchored;
  - `consumedDecisions()` reports exactly which commitments were consumed, so the partial consumption is
    auditable;
  - a new attempt needs a new requester decision.

  This is fail-closed and tested. It is not atomic, and it is not claimed to be.

**Tested against the real service:**
- valid pair;
- same principal (twice);
- another person's passkey;
- forged operator reference;
- CORE-05 or other-subject decision (not consumed);
- wrong digest;
- expiry;
- revocation after decision;
- replay onto another request, namespace, asset, issuer or status;
- re-use after consumption;
- reject verdict;
- permissions denied or failing;
- unknown format, another organization, a failing service, a substituted decision.

## 4. Blockers: founder decisions required before composition

| | Blocker | Why it matters | Recommended decision |
|---|---|---|---|
| **B1** | AUTH-03's `HumanDecisionOutcome` is closed (`recorded` = a CORE-05 verdict, `refused`, `abandoned`). The CORE-05 channel's startup `reconcile()` marks every consumed decision without a CORE-05 verdict `abandoned` | A successful bootstrap's decisions would be **recorded in AUTH-03's audit trail as abandoned**: misleading evidence. A test pins it: after authorization, both decisions remain unsettled | Add an additive outcome, for example `{ outcome: 'recorded-external', recordKind: 'sovereign-status-bootstrap', recordDigest }`, written in the same flow. This is an AUTH-03 change with its own review |
| **B2** | The bootstrap decisions share AUTH-03's commitment domain and format with CORE-05 decisions, separated only by the `approvalRequestId` prefix | Separation by convention, not by domain. The adapter refuses foreign decisions, but the CORE-05 channel would not know to | A distinct contract `format`, or domain, for bootstrap decisions in AUTH-03 |
| **B3** | Structural pins: only `human-authority-composition.ts` (and two readers) may import the AUTH-03 composition, and `composition-root.ts` may not mention `human-identity` | Composing the authorizer requires a deliberate edit of those pins | Compose inside `human-authority-composition.ts`, exposing a narrow bootstrap-decision port, and update the pin test with that reason |
| **B4** | No permission for "request" or "approve" a status-history bootstrap. `authority.bootstrap` means organization bootstrap | Reusing it would change its meaning, and adding one edits the closed `OPERATOR_PERMISSIONS` | Two new permissions, for example `status-history.bootstrap.request` and `status-history.bootstrap.approve`, with an explicit role mapping |
| **B5** | AUTH-03 verdicts are `approve` or `reject`. There is no "request" verdict, so the requester signs an `approve` over the same subject | It works, and is tested, but the requester's decision means "I attest this request", not "I approve it" | Accept as documented, or add a verdict in the same change as B1 |
| **B6** | No Host service can authenticate a status **source**: no registry, no witness, no signed currentness statement. The FV-P4C-2B1 classes need an authenticated source response | Without one, `StatusSourceVerifier` can only be synthetic. Inventing a signed source format would be a new security contract | Decide the first source class (recommended: an issuer channel with a pinned key over a signed currentness statement, specified first as a profile in Soberanía), or wait for the FV-P4D witness |

Until B1–B4 and B6 are decided, the bootstrap is **not operational**.

**The source verifier is synthetic, and test-only.** The only `StatusSourceVerifier` implementations are
in test code: `tests/fv-status-bootstrap-support.mjs` and the end-to-end tests. Nothing in `src/` provides
one, no runtime path reaches the coordinator (a structure test pins it), and nothing here can authorize
a production bootstrap.

## Dependency map for the next phases (design only)

```
FV-P4C-2B2B  authority lifecycle            FV-P4D-1  issuer currentness profile
  B2 typed bootstrap decision domain          B6 signed issuer-currentness assertion (Soberanía profile, PROPOSED)
   └─► B5 requester attestation vs approval     ├─ registry or witness semantics (who answers, how freshness is bounded)
        └─► B1 external decision settlement     ├─ missing-update limits (a withholding source stays undetectable without a witness)
             (audited outcome, CORE-05          ├─ rollback / replay requirements (sequence + digest, challenge, max age)
              reconciliation unchanged)         └─ rc.3 compatibility (existing signing primitives, payload domain separation)
   B4 request / approve permissions (independent; needed before composition)
        └─► B3 controlled human-authority composition boundary ─► Host composition, registration, backup, restore quarantine (schema v3)
                                                                   └─ requires B6 for any source class beyond synthetic
```

- **B2 before B5 and B1.** A typed domain lets AUTH-03 tell a bootstrap decision apart without
  conventions. B5 and B1 then extend that domain, never CORE-05's.
- **B1 must not weaken CORE-05 reconciliation.** It adds a versioned settlement for external decisions;
  it does not ignore abandoned decisions, disable reconciliation, or fabricate CORE-05 requests.
- **B4 does not repurpose `authority.bootstrap`.** It adds two permissions, and is independent of the
  others.
- **B3 comes last.** Composition happens only once authority correctness (B1, B2, B4, B5) is settled.
  The operational bootstrap also needs B6.
- **FV-P4D-1 is independent of 2B2B.** It is a Soberanía-side profile plus a Frontera verifier. Nothing
  in it may claim to detect a withheld newer status without a witness. The adapter core exists so the
decisions can be taken on a tested basis, not as an enabled feature.

## 5. Host composition (proposed, not implemented)

The composition follows the AUTH-04A pattern and is not implemented until B1–B6 are decided:
- **Mode flag.** A closed `AOC_ENTERPRISE_SOVEREIGN_STATUS_HISTORY_MODE=disabled|enabled`. Absent means
  disabled, and any related variable set while disabled is refused, as for the human-authority mode.
- **Gate.** A pure assert gate before anything opens: it requires SQLite, human authority enabled, and
  an explicit namespace and path.
- **Handle.** An internal, optional handle exposing only `coordinateStatusHistoryBootstrap` with
  Host-built dependencies: the store, the authorizer factory over AUTH-03, the source verifier, the
  trusted clock and the namespace. Nothing is reachable from HTTP, RPC, payment, execution, automation
  or plugin paths. A structure test already pins that no Host source imports the module.
- **No startup side effects.** Host startup never creates the database implicitly, bootstraps, or
  contacts a source. The file is created only by an explicit, separate initialization step.

## 6. Persistence registration (proposed)

On composition, add a `STORE_DEFINITIONS` entry with:
- condition `sovereign-status-history-enabled`;
- `envVarOnlyWhenComposed: true`;
- version `{ kind: 'meta-row', table: 'sovereign_status_history_meta' }`, schema
  `frontera.sovereign-status-history.v2`;
- integrity: append-only triggers and an evidence ledger, unsigned and **not CORE-07 anchored**;
- `lossEffect`: losing or rolling back the file forgets withdrawals, retired terms and conflicts
  (**widens**), and a lost file is never recreated.

**Classification.**
- **Data class:** receiver security state.
- **Owner:** the receiving Host.
- **Not payment CORE:** `sovereign-status-history` is already classified outside the PAY-07 CORE.

The store-registry structure test (a store count of 17, and the `envVarOnlyWhenComposed` list) and the
PROD-02 drill must be updated with it.

## 7. Backup (proposed)

- Use the registry's existing mechanism: `Database#backup()` for a transactionally consistent copy of a
  live WAL database, then `journal_mode = DELETE` on the copy. Never a raw file copy.
- The manifest records the schema version, the namespace, the history row count (`created_rows`) and the
  evidence count.
- File permissions follow the target directory (`0600` files, `0700` directory). Encryption at rest is
  the backup infrastructure's; none is added here.
- A valid backup proves a consistent snapshot. It does **not** prove the snapshot holds the latest status
  any receiver has seen.

## 8. Restore and quarantine (proposed; requires a schema change)

A restored history can be structurally valid, internally consistent and authentically generated, and
still **older** than the history it replaces. Without an independent anchor (FV-P4D), the Host cannot
tell a rollback from an older valid copy.

| Rule | Mechanism |
|---|---|
| A restored history starts quarantined | A one-way quarantine marker written by the restore step (`afterRestore`) into a new table. The gate and the coordinator refuse every quarantined history (`HISTORY_STORE_UNAVAILABLE` / R2) |
| Validation | Schema, triggers, `quick_check`, namespace, and every row and its latest evidence, as the store already does on open and read |
| A known higher checkpoint blocks a lower history | Needs a checkpoint outside the restore domain. None exists before FV-P4D, so none is claimed |
| Restore never clears latches or withdrawals, never re-bootstraps, never deletes | The store's no-downgrade rules apply to restored files as to any other. Restore writes only the marker |
| Quarantine release | **None.** Releasing requires independent trusted evidence (a witness or an anchored checkpoint, FV-P4D) through a governed procedure. There is no operator switch |

The marker is a schema change (v3). It belongs with composition and registration, not before them, so
that v2 is not bumped twice.

## 9. Recovery (unchanged from 2B1)

| Class | Meaning | Treatment |
|---|---|---|
| R0 | Ordinary restart | Reopen |
| R1 | Interrupted transaction | SQLite rollback |
| R2 | Missing, corrupt, inconsistent or quarantined history or evidence | Fail closed; diagnostics only |
| R3 | Conflict or rollback contradiction | Out of scope; no recovery |

There is no conflict clearing, no reopening of a withdrawal, no reinstatement of retired terms, no
downgrade, and no namespace change.

## 10. Authority evidence binding

What the 2B1 evidence record already carries, unchanged, with no schema change:
- `operatorRef`;
- `authorityRef` = both AUTH-03 decision commitments;
- `bindingDigest`;
- the source references and observation times;
- the request id;
- the resulting revision (`next.revision`).

From the commitments, a reviewer reaches the AUTH-03 `decision_authorized` rows. Those carry each
decision's contract (operator, subject = `sha256:<bindingDigest>`, validity) and its evidence digest,
inside AUTH-03's signed and witnessed chain.

**Proposed for composition (an evidence v2, with ASSURE):**
- explicit `requesterRef` and `approverRef`;
- the authority subject type `frontera.sovereign-status-bootstrap`;
- the approval validity windows;
- the authority verification result.

No passkey material, tokens, keys or documents are recorded. The bootstrap record itself stays
**unsigned**; the signed part is AUTH-03's.

## 11. Limitations

- **Composition.** The bootstrap is not composed, and cannot be operated until B1–B6 are decided.
- **Source.** No trusted status source exists, so the source verifier in every test is synthetic.
- **AUTH-03 audit trail.** Bootstrap decisions remain unsettled there (B1).
- **Restore.** Restore quarantine and backup coverage are designed, not implemented.
- **Inherited from 2B1:**
  - whole-file rollback or deletion is undetectable;
  - a withholding source is believed;
  - the evidence is unsigned.
