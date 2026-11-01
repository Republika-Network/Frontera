# FV-P4C-2B2B — Authority lifecycle and permission integration

**Status:** implemented and tested against the **real** AUTH-03 identity service, the real
Kernel-Authority world, the real CORE-05 passkey channel's reconciliation, and a real SQLite status
history. **Not composed, not operational:** B3 (Host composition) and B6 (a trusted status source)
remain open, and no real bootstrap can run.

It continues `FV_HOST_AUTHORITY_INTEGRATION.md` (FV-P4C-2B2A), which recorded blockers B1–B6. This
document resolves B1, B2, B4 and B5 and states exactly what remains.

| Blocker | Status |
|---|---|
| **B1** external decision reconciliation | **Resolved.** A bootstrap-only settlement in AUTH-03, written by an FV reconciler from the receiver's own evidence. CORE-05 reconciliation code unchanged |
| **B2** dedicated authority domain | **Resolved.** A separate AUTH-03 challenge format and commitment domain |
| **B4** narrow permissions | **Resolved, outside CTRL-02.** Two Kernel-Authority actions, explicit per-human grants, default deny. CTRL-02 is unchanged (see §4 for why) |
| **B5** requester attestation | **Resolved.** A signed role inside the commitment: `attest` (requester) and `approve` (approver) |
| **B3** Host composition | **Open.** Nothing composes the authorizer, the reconciler or the permissions |
| **B6** trusted issuer currentness | **Open.** The only `StatusSourceVerifier` is synthetic, in tests |

## 1. Contract inventory (as found; differences from the task brief)

All of these were read before any change.

| Contract | Found | Difference from the brief |
|---|---|---|
| AUTH-02 identity | `HumanPrincipal`, passkeys with `userVerification: 'required'`, `revokePrincipal`, `revokeCredential`; "evidence of *who*, never of *may*" | none |
| AUTH-03 decisions | `beginDecision` / `peekDecision` / `authorizeDecision` / `recordDecisionOutcome` / `decision` / `unsettledDecisions`. Commitment = SHA-256(`frontera:human-decision-challenge:v1\n` + canonical contract). `authorizeDecision` already refused any `format` other than `frontera.human-decision-challenge.v1` | The brief assumed a `reconcile` on AUTH-03: reconciliation lives in the **CORE-05 passkey channel** (`approval-authority/human-decision.ts`), which reads AUTH-03's `unsettledDecisions()` |
| AUTH-03 outcomes | Closed: `recorded` (CORE-05 verdict), `refused`, `abandoned` | none |
| CORE-05 | Requests only from Kernel `approval_required` decisions; approver standing from Kernel-Authority (`ApprovalAuthorityPort`: `recognition` + `authority`), lineage-revalidated | none |
| CORE-02 | `AuthorityArtifactKind`, 8 closed signing domains | **Not relevant**: AUTH-03 decisions are passkey assertions over a commitment, not CORE-02 artifacts. No CORE-02 kind was added |
| CTRL-02 | `OPERATOR_PERMISSIONS` closed; roles only, no per-human grant, no resource dimension; `organization-administrator` = **every** permission | Adding the two permissions there would grant them to every administrator implicitly, contradicting "no implicit inheritance" (§4) |
| AUTH-03 `decision_outcome` readers | the CORE-05 channel, the AUTH-04B gateway (`identity.decision(...)`), the AUTH-04A composition log | The gateway would have shown bootstrap decisions as "unsettled"; it no longer sees them (§2) |

## 2. B2 — the bootstrap-authority domain

A second AUTH-03 decision domain, beside CORE-05's, in `human-identity/decision-challenge.ts`.

| | CORE-05 domain (unchanged) | Bootstrap-authority domain (new) |
|---|---|---|
| `format` | `frontera.human-decision-challenge.v1` | `frontera.sovereign-status-bootstrap-authority.v2` (v1 retired, FV-P4C-2B2C) |
| Commitment domain | `frontera:human-decision-challenge:v1\n` | `frontera:sovereign-status-bootstrap-authority:v2\n` |
| Evidence format / digest domain | `frontera.human-decision-evidence.v1` / none | `frontera.sovereign-status-bootstrap-authority-evidence.v2` / `frontera:sovereign-status-bootstrap-authority-evidence:v2\n` |
| `verdict` | `approve` \| `reject` | the signed **role**: `attest` \| `approve` |
| `approvalRequestId` | a CORE-05 request id | `frontera.sovereign-status-bootstrap.v2:<percent-encoded namespace>:<bindingDigest>` |
| `subjectDigest` | a CORE-05 subject digest | `sha256:<bindingDigest>` |
| AUTH-03 methods | `beginDecision`, `peekDecision`, `authorizeDecision`, `recordDecisionOutcome`, `decision`, `unsettledDecisions` | `beginBootstrapAuthorityDecision`, `peekBootstrapAuthorityDecision`, `authorizeBootstrapAuthorityDecision`, `recordBootstrapAuthoritySettlement`, `bootstrapAuthorityDecision`, `unsettledBootstrapAuthorityDecisions` |

The name follows AUTH-03's `.vN` convention rather than FV's `/1` because it is an AUTH-03 contract
format. Identical fields commit to different values in the two domains (tested).

**v2 (FV-P4C-2B2C).** The request id now names the status history namespace the bootstrap targets,
inside the signed contract, so the reconciler can tell which one history must hold the evidence
(`FV_RECONCILER_LIVENESS.md` §3). v1 named only the digest. It was never composed by any Host and is
retired: a v1 challenge or decision row is store corruption, never read as either domain. The
`authorityRef` format (`frontera.sovereign-status-bootstrap-authority.v1:…`, an FV evidence field)
is unchanged.

**What is bound.** The organization (AUTH-03's own, never a caller's), the signed role, the operator,
a 256-bit nonce, a validity window of at most 120 s, and the FV-P4C-2B1 **binding digest**
(`bootstrapBindingDigest`, unchanged). The digest covers the receiver namespace, asset, issuer,
manifest, status sequence and digest, terms, operation, purpose, request id, requesting operator and
request expiry. These fields are bound through the digest, not repeated as contract columns: adding
columns would have needed an AUTH-03 store schema change for no additional binding. The Host UI must
show the human the fields the digest commits to; the human signs the digest.

**Separation, in both directions:**
- A bootstrap decision is refused by every CORE-05 method: `peekDecision` and `authorizeDecision`
  refuse its format, `decision()` returns `undefined`, `unsettledDecisions()` never lists it, and
  `recordDecisionOutcome` refuses it. Neither CORE-05 nor the Authority gateway can see or settle it.
- A CORE-05 decision is refused by every bootstrap method, even one naming the bootstrap request id
  and subject (the 2B2A shape). It is not consumed.
- An organization-bootstrap approval (`authority.bootstrap`) is not an AUTH-03 decision at all, and a
  CORE-05 approval cannot be presented.
- Cross-domain replay fails, since the commitment domains differ.

**Chain compatibility.** The projection of AUTH-03's signed history now fixes each consumed decision's
domain by its evidence format. A CORE-05 outcome on a bootstrap decision, a bootstrap settlement on a
CORE-05 decision, or a second outcome of either kind is **store corruption**. No new row kind and no
schema change: the domain lives inside the existing `decision_authorized` / `decision_outcome` rows.
Existing CORE-05 rows project exactly as before. Their commitments, evidence digests and outcomes are
unchanged. A store holding bootstrap rows cannot be read by an older binary, which refuses it as
corrupt; that is fail-closed, not a migration.

## 3. B5 — requester attestation

| Role | Signed `verdict` | Meaning | Permission (§4) |
|---|---|---|---|
| Requester | `attest` | "I, the operator named in the request, intend exactly this bootstrap" | `status-history.bootstrap.request` |
| Approver | `approve` | "I, a different human, authorize exactly this bootstrap" | `status-history.bootstrap.approve` |

`reject` does not exist in this domain. The role is inside the commitment the passkey signs, so:
- an approval cannot be presented as an attestation, nor the reverse (`ROLE_MISMATCH`, tested);
- one decision cannot serve as both roles;
- two decisions by the same human are refused (`SAME_PRINCIPAL`);
- the requester must be the request's `operatorRef`;
- each decision is single-use and request-bound, so it cannot be replayed onto another request;
- AUTH-03 refuses expired, revoked-principal and revoked-credential decisions at consumption.

A signature grants nothing by itself. The permissions of §4 are checked before anything is consumed.
Both decisions remain independently auditable as two `decision_authorized` rows in AUTH-03's signed,
witnessed chain. The evidence `authorityRef` names both in role order:
`frontera.sovereign-status-bootstrap-authority.v1:<requester commitment>:<approver commitment>`.

## 4. B4 — permissions

| Permission | Allows |
|---|---|
| `status-history.bootstrap.request` | signing the requester attestation for one exact binding |
| `status-history.bootstrap.approve` | signing the independent approval of that binding, as another human |

**Where a grant lives: Kernel-Authority, not CTRL-02.** CTRL-02's vocabulary is closed and
role-based, and `organization-administrator` is defined as `new Set(OPERATOR_PERMISSIONS)`. Adding the
names there would hand both to every administrator: the inheritance B4 forbids. CTRL-02 also has no
per-human grant and no resource dimension. The Host already has the right primitive: the durable
Kernel-Authority world that CORE-05 uses for approver standing.
- **What a grant is.** A grant is an authority grant (or a delegation of one) whose `actions` name the
  permission, over the resource scope `frontera.sovereign-status-history:<percent-encoded namespace>`.
- **How it is created and kept.** It is provisioned explicitly per human, through the existing operator
  provisioning surface. It is revocable, may expire, and is trust-domain- and organization-scoped.
- **How it is checked.** It is lineage-revalidated on every read.
- **Actions match exactly.** There is no wildcard, and neither permission implies the other.
- **Namespace-level grants exist** through Kernel-Authority's resource scope. Scope containment is
  Kernel-Authority's own: a grant on the root `frontera.sovereign-status-history` covers every
  namespace, explicitly.

`createKernelAuthorityBootstrapPermissions({ standing, organizationId, now })` returns `true` only when
all of these hold:
- a scope names this organization, a valid namespace and a binding digest;
- the actor `operator:<id>` is recognized;
- `authority(...)` returns `valid: true` at the Host's trusted instant.

Anything else, a truthy non-boolean included, is `false`. A throw becomes `PERMISSION_SERVICE_FAILED`.
The `standing` port has exactly the shape of CORE-05's `ApprovalAuthorityPort`. The tests build it the
same way `composition-root.ts` builds CORE-05's: recognition, authority-graph integration and lineage
revalidator, over a real provisioned world.

**What neither permission can reach.** Each one authorizes a single signed decision, consumed inside a
coordinator that has none of these operations:
- reset;
- conflict clearing;
- reopening a withdrawal;
- reviving retired terms;
- lowering the sequence or the time floor;
- replacing the database;
- skipping source verification.

**CTRL-02 is unchanged**, and a test pins that no CTRL-02 role, `organization-administrator`
included, holds either permission. Holding a passkey, the administrator role, or `authority.bootstrap`
over the history scope confers nothing (tested).

**Trust root.** Whoever may provision Kernel-Authority grants (CTRL-02 `authority.provision`) can
grant these permissions. That is the existing provisioning trust root, and it is recorded in the
Kernel-Authority event trail. Whether bootstrap grants need an extra provisioning control (for example,
a second provisioner) is a governance decision, not made here.

## 5. B1 — external settlement lifecycle

```
           AUTH-03 (signed, witnessed chain)                         FV SQLite history (v2, unchanged)
 ┌──────────────────────────────────────────────────┐        ┌──────────────────────────────────────┐
 │ 1 issued ─► 2 passkey verified ─► 3 consumed      │        │ 4 bootstrap committed: mark + evidence │
 │                                   (unsettled)     │        │   in one transaction (2B1)             │
 │                                       │           │        │   authorityRef = role-ordered pair     │
 │                         6 settlement ◄┘           │◄─ 5 ───│   evidence validated on read           │
 │   bootstrap-committed | bootstrap-not-committed   │ reconciler reads, verifies, correlates
 └──────────────────────────────────────────────────┘        └──────────────────────────────────────┘
```

| State | Where | Meaning |
|---|---|---|
| 1 issued / expired | AUTH-03 challenge table | a challenge exists; nothing is signed |
| 2–3 consumed | `decision_authorized` row | a verified human decision, **not** a bootstrap result |
| 4 committed | FV history + evidence | the history was anchored |
| 5 evidence verified | reconciler | the evidence record validates and names this commitment in its role |
| 6 settled | `decision_outcome` row (bootstrap kind) | `bootstrap-committed`, citing the evidence digest, request id and transition; or `bootstrap-not-committed` with a closed code |

**The reconciler** is `createBootstrapAuthorityReconciler`. For each unsettled bootstrap decision
in the run's page (at most `maxDecisions`, in commitment order after a rotating cursor:
`FV_RECONCILER_LIVENESS.md` §2):

| Situation | Result | Write |
|---|---|---|
| Not a well-formed consumed decision of this domain and organization (another format, an `external: true` record, a role mismatch) | conflict `DECISION_MALFORMED` | none |
| In flight in this process (Host registry) | unresolved `IN_FLIGHT` | none |
| Inventory not loaded, unavailable, malformed, untrusted, duplicated, stale or changed (FV-P4C-2B2C) | unresolved `INVENTORY_*` | none |
| Any history store unreadable, or its evidence corrupt | unresolved `HISTORY_UNAVAILABLE` / `HISTORY_CORRUPT`; never treated as "no evidence" | none |
| No evidence, and the decision's own namespace is not in the inventory (FV-P4C-2B2C) | unresolved `HISTORY_NOT_IN_INVENTORY` | none |
| The listing names one commitment twice (FV-P4C-2B2C) | conflict `DECISION_DUPLICATE` | none |
| More than one evidence record for the binding | conflict `MULTIPLE_EVIDENCE` | none |
| Evidence names this commitment in the **other** role, or another operator for the requester | conflict `EVIDENCE_CONTRADICTS_DECISION` | none |
| Evidence names this commitment in its role | `bootstrap-committed` | one settlement row |
| Evidence exists, naming other decisions | `bootstrap-not-committed` / `ANCHORED_BY_OTHER_DECISIONS` | one settlement row |
| No evidence, consumed less than `graceSeconds` ago | unresolved `WITHIN_GRACE` | none |
| No evidence, past grace, not in flight | `bootstrap-not-committed` / `NO_BOOTSTRAP_EVIDENCE` | one settlement row |
| AUTH-03 append failed | unresolved `SETTLEMENT_FAILED` | none |
| A different settlement already exists | conflict `SETTLEMENT_CONFLICT` | none |
| Evidence appears right after a not-committed write | conflict `EVIDENCE_APPEARED_AFTER_NOT_COMMITTED` | the earlier row stands; surfaced, never rewritten |

**AUTH-03 checks every settlement against the signed history.** It does not rely on the reconciler for
any of these:
- the decision is a consumed bootstrap decision;
- the settlement names the decision's own binding digest;
- the keys are closed and the codes are closed (an `external: true` key is refused);
- a `bootstrap-committed` counterpart is a consumed bootstrap decision of the **other** role, by
  **another** human, on the same subject;
- the counterpart's own settlement, if any, agrees.

An identical second settlement returns `unchanged`; any other second settlement is
`HUMAN_IDENTITY_DECISION_SETTLEMENT_CONFLICT`. Every settlement is one append: no signed row is ever
rewritten (tested by row digest).

**What AUTH-03 cannot check.** AUTH-03 cannot read the FV history, by the architecture: it may not
import FV. That the cited evidence exists is the reconciler's verification, in-process. A
`bootstrap-committed` settlement is therefore an in-process Host statement, cross-checked against the
signed decisions. It is not a proof AUTH-03 derived from the FV store. A reviewer can recompute it:
the settlement's `bootstrapEvidenceDigest` is
`sha256("frontera:sovereign-status-bootstrap-evidence:v1\n" + canonical evidence record)` over the
record `readBootstrapEvidenceForBinding` returns.

**CORE-05 compatibility.** `approval-authority/human-decision.ts` is byte-identical: its
`reconcile()` still settles every consumed **CORE-05** decision `recorded` or `abandoned` (regression
tested with the real channel). It simply never receives a bootstrap decision. A structure test pins
that the file never names this domain.

## 6. Cross-store consistency

There is no distributed transaction between the AUTH-03 store and the FV SQLite history, and none is
assumed.

| Failure point | State left | Recovery |
|---|---|---|
| After the requester's consumption, before the approver's | requester consumed, bootstrap denied | settles `NO_BOOTSTRAP_EVIDENCE` after grace |
| After both consumed, source or transition refused | both consumed, no evidence | settles `NO_BOOTSTRAP_EVIDENCE` after grace (end-to-end tested) |
| Crash between consumption and commit | both consumed, no evidence, nothing in flight after restart | settles `NO_BOOTSTRAP_EVIDENCE` after grace |
| Commit done, reconciliation never ran or interrupted | durable evidence, unsettled decisions | next run settles `bootstrap-committed` (tested across restart) |
| History unreadable during reconciliation | unchanged | unresolved; retried next run |
| AUTH-03 append fails during settlement | unchanged | unresolved; retried next run |
| Concurrent reconcilers | one row per decision | identical second settlement is `unchanged` (tested) |

**The one irreducible race.** A coordinator call that stalls past `graceSeconds` while not registered
as in flight could commit after a `NO_BOOTSTRAP_EVIDENCE` settlement. It is detected in two places:
- the reconciler re-reads immediately after writing, and reports
  `EVIDENCE_APPEARED_AFTER_NOT_COMMITTED`;
- later, AUTH-03 refuses to settle the counterpart as committed against it (`SETTLEMENT_CONFLICT`).

It is never auto-resolved. The composition (B3) must register each authorizer's commitments as in
flight from consumption until `coordinateStatusHistoryBootstrap` returns, and run the reconciler after
each bootstrap and at startup.

## 7. Audit correlation

From one bootstrap, a reviewer can follow:

| Item | Where | Correlated by |
|---|---|---|
| Bootstrap request | FV evidence (`requestId`, `operation`, `purpose`, `operatorRef`) | `bindingDigest` |
| Requester attestation | AUTH-03 `decision_authorized` (role `attest`) | commitment = 1st half of `authorityRef`; subject = `sha256:<bindingDigest>` |
| Approver authorization | AUTH-03 `decision_authorized` (role `approve`) | commitment = 2nd half of `authorityRef` |
| AUTH-03 commitments | the signed, witnessed chain head | chain digest |
| Verified source statement | FV evidence `sources` | same record |
| FV bootstrap evidence | `sovereign_status_bootstrap_evidence` | `bootstrapEvidenceDigest` in both settlements |
| Committed HWM transition | evidence `previous` / `next`; settlement `historyRevision`, `statusSequence`, `statusDigest` | equal values |

**Limitations:**
- the FV evidence record stays **unsigned** (`host-recorded-unsigned`, 2B1);
- whole-file rollback of the history is undetectable without FV-P4D;
- the AUTH-03 settlement is signed by the identity store's head, but its claim about FV is an
  in-process statement (§5).

## 7a. Security findings (self-review; no independent review has been performed)

**F1 — HIGH. Two demonstrated paths, both remediated in FV-P4C-2B2B-F1.**

*The finding.* Two in-process paths could record a `bootstrap-committed` settlement for a bootstrap that
never committed. Both were reproduced against the real AUTH-03 service before the fix:
1. A direct `recordBootstrapAuthoritySettlement(commitment, settlement)` call by any holder of the
   general identity service, with an invented request id, evidence digest and transition.
2. A reconciler given a look-alike `BootstrapEvidenceReader` that returned a well-formed but
   nonexistent bootstrap.

*Root cause.* The settlement write was a method on the general service, gated by nothing but shape.
The reconciler accepted any object shaped like an evidence reader. AUTH-03 cannot verify FV evidence:
the record is unsigned and lives in another store.

*Remediation:*
- **A settlement capability.** `recordBootstrapAuthoritySettlement(capability, commitment, settlement)`
  first requires the service's own live `BootstrapSettlementCapability`. Since R1, the capability is
  also the reconciler's settlement port, with its methods bound to its service:
  - The token is opaque and frozen. It is registered in a module-private `WeakMap` against exactly one
    service instance, and can be revoked (`revokeBootstrapSettlementCapability`).
  - It is issued only by `createHumanIdentityServiceWithBootstrapSettlement`, to its caller, at
    construction. `createHumanIdentityService` never issues one, so the default is deny.
  - Refused, before anything is read, with `HUMAN_IDENTITY_DECISION_SETTLEMENT_UNAUTHORIZED`: no
    capability, a look-alike, a copy, a prototype child, another instance's token (even over the same
    signed store), and a revoked token.
  - A commitment, a string, a role or a flag is never a capability.
- **Genuine history handles only.**
  - `createBootstrapAuthorityReconciler` takes `settlement` (the capability), a required `inFlight`
    registry, and `histories: { store, namespace, databasePath }[]`.
  - Each `store` must be a handle that `openSqliteStatusHighWaterMarkStore` returned in this process,
    for exactly the configured namespace and resolved database file. This is checked by module-private
    provenance (`trustedBootstrapEvidenceSource`, not exported from the module index). A look-alike, a
    frozen copy of a real handle, or a handle declared for another namespace or file is refused at
    construction.
  - Evidence is read through the store's own internal statements and validators, never through the
    handle's methods. Each record is fully validated, and the committed transition must still be in
    the durable history (revision ≥ `next.revision`).
  - A closed handle, or corrupt or missing evidence, gives `HISTORY_UNAVAILABLE` (unresolved), never
    "no evidence". No database is created as recovery.

*Verified.* The two original probe scripts, rerun verbatim, are refused: `SETTLEMENT_UNAUTHORIZED`, and
`TypeError: not a genuine status history store handle`.
`fv-p4c2b2b-f1-settlement-authenticity.test.ts` reproduces both exploits and the 20 required cases
against the real AUTH-03 and real SQLite.

*Remaining trust assumptions. These are in-process and not cryptographic:*
- **The settlement capability holder.** It can still record any settlement that passes AUTH-03's own
  checks (binding, roles, counterpart, idempotency). It is trusted to settle only from genuine evidence:
  the reconciler is its only intended holder, and the B3 composition must not pass it anywhere else.
- **Holders of the raw AUTH-03 store** (`HumanIdentityStore.append`) could write any signed row. That
  is the pre-existing AUTH-03 boundary. Only `human-authority-composition.ts` opens the store, but its
  `ComposedHumanAuthority` result **exposes** it as `store`. The capability therefore defends against
  holders of the *service*, not holders of the *store*. B3 must not hand the composed `store` to the
  bootstrap subsystem.
- **Holders of a writable history handle** can write real evidence. That is the pre-existing FV
  boundary.
- **Provenance proves origin, not freshness.** It proves the evidence came from a genuine handle's
  durable, validated state. It does not prove the file is the latest history: whole-file rollback or
  replacement on disk stays undetectable until FV-P4D.
- **A compromised process or host is out of scope.**
- **The FV evidence remains unsigned and unwitnessed.**

*Independent review fixes (a separate review agent, given the code but not the author's conclusions):*
- **R1, High: the capability could be stolen through the shared service object.** The service object
  was mutable, and the reconciler passed the token through a method on it. Code holding only the
  general service could replace that method, capture the token on the next run, and forge a
  settlement. The reviewer reproduced it. Fixes:
  - the service object is frozen;
  - the capability is now itself the settlement port: a frozen object whose methods are bound at
    issuance to the service it was issued for;
  - the reconciler takes it as `settlement` and never hands any token to another object.

  The reviewer's exploit script, rerun verbatim, now fails at the method replacement (`TypeError`).
  Regression: "REVIEW FINDING 1".
- **R2, Medium: permission scope bled across namespaces.** Kernel-Authority scope containment is
  `:`-hierarchical, and namespaces may contain `:`. A grant for namespace `receiver` covered
  `receiver:acme`. `statusHistoryResourceScope` now percent-encodes the namespace (tested).
- **R3, Low: not-committed could contradict a committed counterpart.** AUTH-03 now refuses a
  `bootstrap-not-committed` settlement for a decision that a committed counterpart names, and the
  reconciler's race comment is corrected. A commit landing *after* a run that settled both decisions
  not-committed is still undetected (F3).
- **R4, Low: an unsafe default.** The reconciler's `inFlight` registry is now required; there is no
  "nothing is in flight" default.
- **R5, Low: the history list is not checked for completeness.** If the Host left a namespace's
  store out of `histories`, that namespace's committed bootstraps settled as not committed (a false
  failure, never a false success). **Remediated in FV-P4C-2B2C**: the signed decision names its
  namespace, and absence is believed only from that namespace's present, genuine history
  (`FV_RECONCILER_LIVENESS.md` §3).
- **Info.** Permissions are namespace-wide; the binding digest is format-checked only. Kernel-Authority's
  resolver weighs only an actor's first grant for an action, so a second, wider grant of the same
  action is ignored. That is a pre-existing false deny, and it fails closed.

*Status.* **Both demonstrated paths and the reviewer's theft path are closed.** F1 stays a precondition for B3. The composition must
hold the capability exclusively, and hand it only to the reconciler, together with the genuine handles.

**F2 — MEDIUM. Reconciler starvation.** Decisions that stay unresolved or in conflict keep the oldest
`maxDecisions` slots, so newer decisions are never processed. This was demonstrated: two stuck decisions
with `maxDecisions = 2` blocked a valid one on every run. The effect is availability only: no false
settlement results. CORE-05 is unaffected.
- **Remediation:** skip decisions that are known to be stuck, or keep a cursor so that each run makes
  progress past them, and report them for operator investigation.
- **Remediated in FV-P4C-2B2C** with a rotating commitment-order cursor (`FV_RECONCILER_LIVENESS.md` §2).
  The original two-stuck-ahead-of-one-valid, `maxDecisions = 2` case is the acceptance test.

**F3 — MEDIUM. Grace race.** A coordinator call that stalls past `graceSeconds` without being
registered as in flight can be settled `NO_BOOTSTRAP_EVIDENCE` and then commit. It is detected and
reported, never auto-corrected (§6). The record it leaves is a false *failure*, never a false success.
- **Remediation:** B3 must register commitments as in flight from consumption to the coordinator's
  return.

**F4 — LOW. Idempotency is on the recorded settlement.** An identical second settlement is
`unchanged` without re-reading the evidence. After F1, a first settlement can only be written through
the capability. The reconciler writes it only from a genuine handle's evidence, so there is no longer
a path to an initially fabricated success that a replay would then confirm.

**F5 — LOW. Legacy 2B2A-format decisions.** CORE-05-format decisions that carry the bootstrap request
id remain in the CORE-05 domain, and CORE-05 reconciliation abandons them. They existed only in test
stores, since 2B2A was never composed.

**Operator intervention.** There is no manual settlement by design. Decisions reported as `conflict`
need an investigation outside Frontera. They stay unsettled, and that is truthful: neither success nor
failure has been established.

## 8. Not done, by design

- No Host composition, registration, backup, restore or startup reconciliation (B3).
- No trusted status source (B6). The synthetic source exists only in tests.
- No endpoint, CLI, administrative settlement, override or manual reconciliation.
- No change to CTRL-02, CORE-05, CORE-02, ASSURE, Soberanía or the receiver package.
- No FV history schema change (still v2).
- No AUTH-03 store schema change.
- No payment, execution or document authorization: a bootstrap still returns
  `documentAuthorization: 'not_evaluated'`, `execution: 'not_performed'`.

## 9. Next steps

**B3 — controlled composition.**
1. Compose inside `human-authority-composition.ts` with `createHumanIdentityServiceWithBootstrapSettlement`.
   Hand the settlement capability only to the reconciler, together with the genuine history handles
   (F1). Expose a narrow port with the bootstrap-authority methods, the permissions, and a reconciler
   with an in-flight registry (F3), behind
   `AOC_ENTERPRISE_SOVEREIGN_STATUS_HISTORY_MODE=disabled|enabled` (absent = disabled).
2. Update the AUTH-03 composition pins and `fv-p4c2b2-structure` test 49, stating why.
3. Register the store (`STORE_DEFINITIONS`), add backup coverage, and add restore quarantine (history
   schema v3) as designed in `FV_HOST_AUTHORITY_INTEGRATION.md` §6–8.
4. Run the reconciler at startup and after each bootstrap.
5. Decide who may provision the two Kernel-Authority grants, and whether that needs its own control.

**B6 — currentness.**
1. Specify a signed issuer-currentness profile in Soberanía first (FV-P4D-1).
2. Then add a Frontera verifier implementing `StatusSourceVerifier`, with a pinned key, a challenge or
   bounded age, and sequence-and-digest rollback rules.
3. Until a witness exists (FV-P4D), claim nothing about detecting a withheld newer status.

No operational bootstrap may be enabled before both are done.
