# AUTH-04D1R — Human authority recovery and shutdown safety

**Status:**
- **Graceful shutdown:** fixed and CI-qualified. It drains the human-decision authority.
- **Disaster recovery:** a reviewed design, not an implementation. The choice of strategy for irreversible loss needs a separately authorized ceremony.
- **Not deployed:** nothing is deployed, and no infrastructure or production system was changed.
- **Testing:** software authenticators only; no real device.

Founder decision carried in (AUTH-04D1E): the pilot uses the existing evidence-free reference profile unchanged (Option C). Evidence-required profiles remain on their existing approval channels. No evidence-policy bypass.

## 1. Failure modes confirmed

Traced in code, and reproduced in CI where marked:

| # | Mode | Mechanism | Result before | Evidence |
|---|---|---|---|---|
| F1 | **Graceful-shutdown race** | `Enterprise.close()` closed the identity store at once (AUTH-04D1). The gateway drops connections, but its handlers keep running, so a sign-in, enrolment or decision could be between its witness **prepare** and its **local commit** when the store closed. | The witness holds a prepared successor the file never got. The next start fails with `AUTHORITY_FRESHNESS_PENDING_RECOVERY`, and nothing may clear it. | Reproduced: `auth04d1r-identity-store-drain.test.ts` ("REPRODUCED") |
| F2 | **Lost prepare answer** (pre-existing CORE-07 mode, independent of shutdown) | The witness records the prepare, but every attempt's answer is lost (network, a timeout, a crash of the witness's reply path). The transition throws before the local commit. | Same as F1: `PENDING_RECOVERY` at the next write or start. For the identity store this is **irreversible today**: no ceremony resolves it (§4). | Characterized on the Host: `auth04d1r-graceful-shutdown-host.test.ts` ("CHARACTERIZED") |
| F3 | **Process crash or `SIGKILL` between prepare and commit** | The same window as F1, with no chance to drain. | `PENDING_RECOVERY`: fail closed, and irreversible for identity. | By construction (CORE-07 ADR §2.9, case A) |
| F4 | **Decision split across stores** | A decision is: consume (identity), then the CORE-05 verdict (approvals), then the outcome (identity). Shutdown between steps left the store closing under a running decision. | A consumed decision without an outcome is reconciled at the next start (`recorded` or `abandoned`, never a verdict). Safe, but the decision may be lost to `abandoned`. | AUTH-04A reconciliation; now drained (§2) |
| F5 | **Identity volume lost after the newest backup went stale** | Every sign-in, enrolment, revocation or decision advances the witnessed head. | The identity store can never start again at that witness (AUTH-04D1 §5). | AUTH-04D1 drills |
| F6 | **Witness database lost** | Every slot becomes unbound. | Grants, obligations and approvals can be re-enrolled through the existing operator ceremony. `human-identity-state` has **no** enrolment ceremony. | `enroll-authority-state-freshness.mjs` |

Can graceful shutdown fully drain writes without weakening crash recovery? **Yes, for F1 and F4:**
- A write that was never accepted is refused before it is signed or prepared.
- An accepted write runs to its own end, which its own witness timeouts bound.
- Nothing is retried, replayed, acknowledged early or cleared.

F2, F3, F5 and F6 are **not** shutdown problems, and the drain does not claim to solve them.

## 2. The graceful-shutdown fix

`Enterprise.close()` and `stop()` now begin, while every store is still open, with `humanAuthority.drain(bound)`:

1. **Stop new work.** The gateway is already closed by the Host. The Authority port refuses every new decision, inbox read and enrolment-administration call (`draining`, independent of the lifecycle state).
2. **Settle running decisions.** Each `decide()` runs to its end: identity consumption, the CORE-05 verdict, and the outcome row. The approval store is still open, so a decision is not cut between stores.
3. **Prevent new identity writes.** `closeWhenSettled` refuses every write not already accepted before it is signed, prepared or written (tested: it never reaches the witness). Accepted writes, including sign-ins and enrolments, finish their witness transition and local commit.
4. **Close only when safe.** The identity store closes after its last accepted write settles, and its WAL is checkpointed, so the data directory is ready for a cold backup.
5. **Reconcile.** Unchanged. Any consumed-but-unsettled decision is reconciled at the next start; the drain makes this rare.
6. **Fail closed.** A write still running past the bound is cut off and fails exactly as a crash would (F3). This is logged as `enterprise.human_authority.drain_incomplete`.

**Shutdown policy (bound):** `max(AOC_ENTERPRISE_SHUTDOWN_TIMEOUT_MS, 9 × witness timeoutMs × maxAttempts + 5 s)`. A decision makes at most three witnessed transitions in sequence, each at most three witness calls, so a healthy but slow write is never cut (tested: a 500 ms Host bound still waits for the write's 2 s transport bound). The default is `max(30 s, 95 s)`. In practice the drain is immediate.

No decision is acknowledged before its durable commitments complete; the existing order is unchanged. No in-flight assertion is dropped or replayed: a drained decision is recorded exactly once, and its assertion stays consumed after restart.

Changed files:
- `human-identity/sqlite-human-identity-store.ts`: `closeWhenSettled`, and refusal while draining;
- `approval-authority/human-decision.ts`: `settled()`;
- `composition/human-authority-composition.ts`: `drain()` and the draining gate;
- `composition/composition-root.ts`: drain first in `close()` and `stop()`, with the bound.

No witness protocol, signing format, store schema, route or public surface changed.

## 3. Disaster recovery strategies compared

| | **A. Synchronously replicated storage** | **B. Ordered recovery journal** | **C. Audited re-founding** |
|---|---|---|---|
| What | The Host data volume and the witness volume each sit on provider-replicated block storage, in different failure domains | Every witnessed identity transition is also appended, before it is acknowledged, to an off-host ordered journal; recovery replays from the last backup up to the witness head | An authorized ceremony permanently retires the old identity anchor and starts a fresh empty store under a new anchor; every human re-enrols |
| Rollback resistance | Unchanged: no copy is ever promoted | Preserved only if replay must end exactly at the witnessed head; the journal is itself a second anchor that must be ordered and complete | Preserved only if the witness **permanently** records the retirement, so the old store id can never be bound again |
| Revoked credentials | Safe (same file) | Safe if the journal is complete; a gap must refuse | Safe: no old credential exists in the new store |
| Consumed challenges | Safe | Safe if complete | Safe: old challenges are unknown to the new store; old assertions are refused |
| Witness loss | Only physical loss; not deletion or corruption | Does not help: the witness is the anchor | Covers it, with a new witness and anchor (the other stores re-enrol through the existing ceremony) |
| Data-volume loss | Covers disk or zone failure; not deletion, corruption or account compromise | Covers it | Covers it, losing every passkey and the identity history (archived for audit) |
| Evidence and audit continuity | Full | Full | Old identity history is kept only as an archived, verifiable record. CORE-05 verdicts and decision evidence stay in their own signed store. |
| Operator authorization | None (infrastructure) | None at run time; replay is an operator procedure | A **new trust ceremony**: operator-attested, ideally two-person, audited |
| Complexity | Low | High: a second durable write in every transition, with its own failure semantics (a write must not commit unless journaled) | Medium, but it needs a **witness protocol change** (retirement) |
| Infrastructure cost | Moderate (replicated disks for two volumes) | Low infrastructure, high engineering | Low |
| Pilot practicality | **High** | Low | Medium; it needs founder authorization (stop condition) |

## 4. Pilot recommendation (one organization, one Host)

Smallest defensible strategy: **A + the drain + sealed cold backups + degraded mode, with C designed later for irreversible loss.**

- **A for the volumes:** the Host data volume and the witness volume on separate, provider-replicated, encrypted storage in different failure domains. This is the only practical way to keep the newest state through a hardware or zone failure.
- **The drain (this increment):** for every planned stop.
- **Sealed cold backups (AUTH-04D1):** at every planned stop. They support migration and maintenance, not point-in-time disaster recovery.
- **Degraded mode (AUTH-04D1, tested):** if human authority cannot start, run with it disabled; evidence-free CORE-05 approvals continue on the private CTRL-04 operator plane.
- **C, designed later:** a separately authorized increment. With one pilot human, re-enrolment is cheap, which makes C the right eventual answer for F2, F3, F5 and F6. It requires a witness retirement record and a trust ceremony, so it was **not** implemented.
- **B: rejected for the pilot.** It is a second anchor with its own consistency problem.

| Scenario | Outcome | Who acts |
|---|---|---|
| Graceful shutdown | Drains; restart is ready; nothing is lost or replayed | **Automatic** |
| Shutdown with a write stuck past its own bounds | Fails closed (`PENDING_RECOVERY`) | **New security ceremony** (C); until then, degraded mode |
| Unexpected process crash, outside the prepare-to-commit window | Restart is ready; unsettled decisions are reconciled; sessions are lost (sign in again) | **Automatic** |
| Unexpected process crash inside the prepare-to-commit window (F3), or a lost prepare answer (F2) | `PENDING_RECOVERY` for the identity store | **New security ceremony** (C); until then, degraded mode |
| Temporary witness outage | Authority writes refuse while it lasts; reads and the rest of the Host continue (degraded health); they recover by themselves when the witness returns | **Automatic** |
| Permanent identity-volume loss | With A, the replica survives and the Host restarts on it. Without A, or if all replicas are lost after the last backup went stale, see the next row. | **Operator** (remount the replica) |
| Identity volume irrecoverable | Human authority unavailable at that witness; degraded mode | **New security ceremony** (C) |
| Permanent witness loss | Other stores: the existing operator enrolment ceremony. Identity: unbound. | **Operator** for the others; **new security ceremony** (C) for identity |

The probability of F2 and F3 is low but not zero. Their consequence is permanent for human authority until C exists. That is the residual risk the founder must accept for a pilot.

## 5. Tests (remote CI)

**Store level** (`auth04d1r-identity-store-drain.test.ts`, scripted witness transport):
- the F1 race is reproduced (`PENDING_RECOVERY`);
- with `closeWhenSettled`, the accepted write commits and finalizes, a late write and challenge are refused before reaching the witness, and the next open is ready with exactly the expected history;
- the deadline path fails closed;
- the call is idempotent and validates its argument.

**Host level** (`auth04d1r-graceful-shutdown-host.test.ts`, real witness behind a holding proxy):
- **Normal shutdown:** drained, the store closes, restart is ready.
- **Decision mid-submission:** recorded once and readable after restart. The assertion stays consumed and is never replayed. New decisions are refused while draining.
- **Active sign-in:** completes; a new identity write is refused while draining.
- **Active enrolment:** completes, and the passkey is present after restart.
- **Witness outage during the drain:** the write fails as it would, nothing is left prepared, restart works.
- **Lost prepare answer (F2):** the drain still completes within the write's own bound, and the next start fails closed.

**Regression:** the existing AUTH-01 through AUTH-04D1 suites in the same CI run. These cover duplicate submission, missing witness, stale identity snapshot, credential revocation, rollback and restore.

## 6. Infrastructure and custody dependencies (pilot, AUTH-04D2)

- **Storage:** replicated, encrypted block storage for the Host data volume and, separately, for the witness, in different failure domains, with no shared snapshot schedule.
- **Process supervision:** sends `SIGTERM` and waits at least the drain bound before `SIGKILL`. For example, a stop timeout of 120 s with defaults; set it from the drain bound.
- **Secrets:** the secret manager holds the authority signing key, the witness token, the operator secrets and the backup key (AUTH-04D1 §6).
- **Monitoring:**
  - the `enterprise.human_authority.drain_incomplete` log line;
  - `authorityFreshness` health (`pending-recovery`, `unavailable`).

## 7. Remaining irreversible-loss scenarios (until C)

- F2: a lost prepare answer on an identity write.
- F3: a crash between the identity prepare and the local commit.
- F5: identity volume loss beyond the replicas, with the last backup stale.
- F6: witness database loss.

In each case human authority is unavailable for the organization at that witness, and degraded operator-plane mode continues. No case widens authority: CORE-07 anti-rollback, revocation and decision integrity hold throughout.
