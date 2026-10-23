# ADR: Durable single-use consumption and synthetic execution (G-02C1B)

**Status:** Accepted for G-02C1B (reference only)
**Extends:** `ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md` (G-02C1A), `ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md` (G-02A)
**Security statement:** `docs/security/G-02C1B-DURABLE-CONSUMPTION-SYNTHETIC-EXECUTION.md` · invariants SEC-INV-389 … SEC-INV-396
**Founder decisions:** D4 (durable consumption with the G-02A ledger, one shared domain per audience) and D14 (claim → effect → outcome in one handler) for the reference executor only. Receipts (D5–D8), Host presentation (D1) and online status (G-02D) remain deferred.

## Context

G-02C1A verifies a capability against the request the executor received and refuses. G-02C1B lets an eligible capability authorize **one** synthetic effect, so durable consumption, ordering and failure behaviour can be qualified before any real effect or receipt exists.

## Decision

### 1. An explicit mode; verification-only by default

The closed configuration gains `mode`: `verification-only` (also when absent) or `synthetic-execution`.

- **What synthetic mode requires:** a `syntheticExecution` section containing:
  - the one effect, `frontera.synthetic-deployment-record.v1`;
  - an absolute path to an **existing** G-02A ledger;
  - an absolute, dedicated output directory, separate from the ledger;
  - `synthetic.*` actions, each also permitted.
- **No field enables an effect on its own:** the section is refused in every other mode, and so is the optional `faultInjection` (CI crash points).

### 2. The G-02A ledger, unchanged

No second consumption mechanism and no schema change. The launcher opens the configured file with the executor's audience. It never passes `create: true`, so a missing, damaged or foreign-audience ledger refuses startup. The operator initializes a ledger once with G-02A's own explicit `create: true` call.

The ledger already provides:

- an IMMEDIATE, `synchronous = FULL` claim;
- one claim per capability id and per issuer execution;
- the audience pin;
- forward-only outcomes;
- no deletion.

### 3. The sequence, in one synchronous section

1. The G-02C1A pipeline, unchanged, rebuilds the binding from the received bytes and verifies.
2. Only a configured `synthetic.*` action continues.
3. `ledger.claim(verification)` commits durably.
4. The executor re-checks expiry on its own clock. If expired, it records `failed` and performs nothing.
5. **At most one** effect attempt (none if expired or not admitted). The effect itself requires the durable claim to be in state `claimed`.
6. `ledger.recordOutcome`, forward only.
7. One closed answer.

Nothing is awaited from the claim to the answer, so no other request, timer or I/O callback of the process runs between the expiry check and the effect.

### 4. The synthetic effect

One file per capability, `<capabilityId>.json`, in the directory fixed at boot:

- created with `O_CREAT | O_EXCL | O_NOFOLLOW`, written in two halves (so a crash can split it), then flushed;
- the directory itself is flushed afterwards.

The directory must be real, canonical, owned and writable by the executor's user and by no one else. Its ancestors must be owned by that user or root, and sticky if others can write them. Its device and inode are re-checked before each attempt, and the created file is checked to be at the fixed name afterwards. A name already taken is reported `unknown`, never a definite failure.

The record holds only verified identifiers: executor, audience, issuer, capability, execution, the `synthetic.*` operation, the target resource, the rebuilt binding digest, claim and attempt instants. There is no network, command, subprocess, credential or request-supplied path.

### 5. Outcomes and statuses (checked against the Generic HTTP classifier)

| Outcome | Status | Host reads |
|---|---|---|
| refused / assessed-ineligible (before any claim) | 400 / 401 / 403 / 413 / 417 / 431 | rejected |
| already-consumed | 202 | unconfirmed |
| claim-unavailable | 503 | unconfirmed |
| consumed-not-attempted, failed-observed | 422 | rejected |
| attempted-outcome-unknown | 502 | unconfirmed |
| completed-observed | 201 | completed |

Verification-only mode keeps every G-02C1A status. A 202 is never a success: the effect may have happened earlier.

### 6. Recovery is a restart, and never a re-execution

A crash leaves the row as the ledger last committed it. A stranded `claimed` row is the G-02A contract's own unresolved state ("authorized and possibly attempted, outcome not recorded"). It is kept, never released and never completed by assumption, and every later delivery is answered `already-consumed`.

Classifying stranded rows as `outcome-unknown` needs a way to enumerate them, which the G-02A ledger API does not offer. That is deferred, with the C1C evidence gaps.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| A new consumption or receipt table | A second mechanism or a closed-schema migration (stop conditions 3 and 7) |
| Re-attempting a stranded claim at boot | Automatic re-execution after an unknown outcome |
| Answering a duplicate with the earlier success | Would let a 202 or a replay read as completed |
| A request-supplied output path or name | Path injection; the name is the checked capability id |
| An effect that shells out or calls a URL | Out of scope and unsafe; the effect is a local file |

## Consequences

- Within one intact ledger domain: at most one durable admission per capability and per execution, and at most one attempted effect through the reference path.
- Not claimed: exactly-once external outcome, rollback protection, cross-domain uniqueness, revocation after issuance, production readiness or signed receipts.

## Deferred

| Milestone | Scope |
|---|---|
| G-02C1C | Executor receipts; the ledger read API gaps (§ C1C evidence in the security statement) |
| G-02C1D | Host presentation (D1), receipt return, evidence store (D8) |
| G-02D | Online status |
| Founder | Rollback anchoring of the consumption ledger; a stranded-claim classification tool |
