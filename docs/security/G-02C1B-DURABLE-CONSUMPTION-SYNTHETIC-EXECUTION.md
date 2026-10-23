# G-02C1B — Durable Single-Use Consumption and Synthetic Execution: Security Statement

**Design:** `docs/architecture/ADR-DURABLE-CONSUMPTION-SYNTHETIC-EXECUTION.md`
**Invariants:** SEC-INV-389 … SEC-INV-396 (`SECURITY_INVARIANTS.md` §4.42)
**Profile:** reference only, synthetic CI qualification. **Not production-ready. No global exactly-once execution guarantee.**

## 1. What is qualified, and what is not

| Property | G-02C1B |
|---|---|
| At most one durable admission per capability and per issuer execution, **within one intact ledger domain** | Qualified (G-02A ledger; two-process race) |
| At most one attempted effect through the reference path, within that domain | Qualified (claim first; effect requires the claim; no retry) |
| Exactly-once external outcome | **Not claimed** |
| Rollback protection | **Not provided**: a restored ledger re-enables a consumed capability (tested) |
| Uniqueness across separate ledgers | **Not provided**: separate ledgers are separate domains (tested counterexample) |
| Revocation or emergency stop after issuance | **Not observed** offline; bounded only by the window (≤ 60 s) |
| Signed execution receipts | **None** (G-02C1C) |

These are stated explicitly:

1. Consumption uniqueness is per intact ledger domain.
2. Rollback can re-enable a consumed execution.
3. Different ledgers are different domains.
4. Consumption precedes the effect.
5. Nothing is retried after an unknown outcome.
6. A durable claim does not prove the effect completed.
7. Synthetic completion is not external settlement.
8. Offline revocation cannot be observed immediately.
9. There are no signed receipts yet.
10. There is no production-readiness claim.
11. There is no global exactly-once guarantee.

## 2. Durable-consumption threat model

| Adversary or event | Can | Cannot (enforced) |
|---|---|---|
| A replaying client (valid credential, a consumed capability) | Redeliver it, alone, concurrently or after a restart | Cause a second claim or effect in the same domain; get a success status (202) |
| A client with a second capability for one execution | Present it | Claim it (`EXECUTION_CONSUMED`) |
| A request rewriter | Alter body, target or headers | Pass the rebuilt binding; the claim is never reached |
| Two executor processes sharing the ledger | Race on one capability | Both claim: the IMMEDIATE transaction serializes them |
| A crash at any point | Strand a claim, or leave a partial or complete record | Trigger a re-execution; release the claim; turn an unknown into completed |
| A local attacker who can plant links or swap the output directory | Point the record path or the directory elsewhere | Redirect the write: exclusive no-follow create; directory identity re-checked |
| Whoever can rewrite or restore the ledger file | Forget consumptions | **Not defended** (rollback; residual R1) |
| Whoever controls the configuration or the executor host | Change trust or the directory | **Not defended**: the executor's operator is its trust root |

## 3. Synthetic effect contract (`frontera.synthetic-deployment-record.v1`)

- **Meaning:** "synthetic release *operation* was applied to synthetic target *resource*". It is not a deployment.
- **Input:** only the verified capability, the rebuilt binding digest and the executor's own instants. Nothing comes from the raw request.
- **Location:**
  - The output directory is fixed at boot and must be real, canonical and writable by its owner only.
  - Its device and inode are re-checked before every attempt.
  - The file name is the checked 64-hex capability id plus `.json`.
- **Write:**
  - `O_CREAT | O_EXCL | O_NOFOLLOW` with mode 0600, so it never follows a link or overwrites a file;
  - written in two halves, then `fsync`; the directory is `fsync`ed after.
- **Precondition:** the ledger holds a durable claim for that capability in state `claimed`.
- **Content:** executor id, audience, issuer, capability id, execution id, operation, target, binding digest, claim and attempt instants, `observed: applied`. It never holds the capability text, credential, headers or body.
- **Never:** network, command, subprocess, `eval`, dynamic code, credentials, payment, production configuration, or customer data.
- **Observations:**
  - `not-attempted`: nothing was created.
  - `failed`: the exclusive create was refused; nothing was written by this attempt.
  - `unknown`: the file was created, then a write, flush or close failed; a partial record may exist.
  - `completed`: written and flushed.

## 4. Ordering, and where a real effect could occur

| Step | Durable? | A real effect could have occurred? |
|---|---|---|
| Verification (G-02C1A pipeline) | no | no |
| Claim committed (`IMMEDIATE`, `synchronous = FULL`) | **yes** | no |
| Expiry re-check | no | no |
| `openSync(… O_EXCL …)` succeeds | — | **from here on** |
| Record written and flushed | the record | yes, completed |
| Outcome recorded | **yes** | — |
| HTTP answer | — | — |

The claim and the effect are not one atomic transaction:

- a committed claim does not prove the effect happened;
- a complete record does not prove the ledger says `completed`;
- a crash can leave either without the other.

The in-process suite asserts the exact event order from an instrumented ledger and effect. The crash matrix shows the durable consequences.

## 5. Failure and crash-recovery matrix (CI, separate processes, `SIGKILL` at each point)

| Case | Ledger after | Record after | Effect may have occurred | Automatic retry | Next delivery | Observation |
|---|---|---|---|---|---|---|
| C1 crash before the claim transaction | absent | none | no | n/a (nothing consumed) | **claimed and performed** (201): it is the first delivery | known: nothing |
| C2 crash inside the claim transaction | absent (uncommitted) | none | no | n/a | 201 | known: nothing |
| C3 crash right after the durable claim | `claimed` | none | no | **never** | 202, nothing performed | unknown to a reader (`claimed`) |
| C4 crash after the expiry check | `claimed` | none | no | never | 202 | unknown to a reader |
| C5 crash during the effect | `claimed` | **partial** | partially | never | 202 | unknown |
| C6 crash after the effect, before the outcome | `claimed` | complete | yes | never | 202 | unknown to the ledger |
| C7 crash after the outcome, before the answer | `completed` | complete | yes | never | 202 (`completed`) | known |
| C8/C9 client disconnect after the claim or after the effect | `completed` | complete | yes | never | 202 | known; the answer was lost |
| C10 restart with a stranded claim | kept `claimed` | as left | as left | never | 202 | unknown, preserved |
| Ledger busy at claim | absent | none | no | n/a | the next delivery claims it | known: nothing (503) |
| Outcome cannot be recorded | `claimed` | complete | yes | never | 202 | answered unknown (502) |
| Expired after the claim | `failed` | none | no | never | 202 | known: not attempted (422) |

**C8 and C9 cannot be separated in time.** Claim, effect and outcome run synchronously once the request is parsed, so a disconnect cannot interleave with them.

**Recovery rules.**

- On restart the ledger's integrity, triggers, schema and audience are checked by G-02A.
- Rows are never discarded or recreated.
- A `claimed` row is never released, completed by assumption or re-executed.
- Terminal rows keep their result.
- A duplicate never runs an effect and never receives a fabricated success.

## 6. Reference deployment limitations

- One executor host, local filesystem, one shared ledger per audience. Network filesystems are not supported.
- Loopback plain HTTP. TLS, DNS and proxies are not qualified.
- Fault injection (`faultInjection.crashAt`) is a configured `SIGKILL` of the executor itself, accepted only in `synthetic-execution` mode in the `reference-synthetic` environment.
- The output directory's identity is re-checked before each attempt. A swap between that check and the create is not prevented; the final component is never followed (residual R4).

## 7. C1C durable-evidence dependencies

| Fact C1C needs | G-02A ledger today |
|---|---|
| Executor identity | Implicit: the ledger is pinned to the audience. The executor id is in the configuration and the synthetic record, not the ledger |
| Capability, execution, issuer | Stored and readable |
| Audience | Stored in the ledger meta and readable as `ledger.audience` |
| Organization, trust domain | Stored, **not returned by `read()`** |
| Rebuilt binding digest | `action_binding_digest` holds the **capability's** signed digest (equal, since claims follow verification), **not returned by `read()`** |
| Claim reference and timestamp | `capability_id`, `claimed_at`: readable |
| Observed outcome | `state`: readable |
| Observation timestamp | `outcome_recorded_at`: stored, **not returned by `read()`** |
| Expiry | stored, **not returned** |
| Safe effect reference | Not in the ledger. It is the record name `<capabilityId>.json` (derivable) |
| Forward-only transitions | Enforced by triggers |
| Unresolved state after a crash | `claimed`, readable; **no way to enumerate stranded rows** |

**Gap:** every fact exists durably except the executor id (configuration) and the effect reference (derivable), but the read API does not return the binding digest, the outcome timestamp or the expiry, and cannot list unresolved rows. This makes C1C receipt signing an **API** question, not a missing durable fact, so it is not fundamentally unsafe.

**Smallest C1C-compatible proposal (not implemented):** an additive, read-only `readDetail(capabilityId)` and `listUnresolved()` on the G-02A ledger, with no schema change. Receipts would live in their own ledger file, as Phase 0 proposed.

## 8. Adversarial coverage

| Threat | Result | Test |
|---|---|---|
| Invalid signature, unknown issuer, other audience, cross-organization, expired, status-required, altered body, target or header, duplicate presentation, no or wrong credential, non-synthetic action | no claim, no effect, ledger and directory untouched | in-process suite |
| Sequential, concurrent, restarted, lost-response and same-execution duplicates | one claim, one effect, 202 | in-process and process suites |
| Two processes, one ledger, twelve races | exactly one 201 and one 202 each time; twelve records | process suite |
| Two processes, two ledgers | both perform: stated limitation | process suite |
| Crash at six points plus inside the claim transaction | matrix above | process suite |
| Expiry after claim; ledger busy; outcome unrecordable; partial write | 422; 503 with nothing consumed; 502; `outcome-unknown` | in-process suite |
| Planted link; existing record; swapped directory; traversal names; no claim; unsafe directories | refused, nothing written outside | in-process suite |
| Restored older ledger | re-claimable: rollback is not prevented | in-process suite |
| Missing, foreign or damaged ledger; unsafe output; incomplete or unknown mode | startup refused, nothing created | process suite |
| Secrets, presentations, capabilities or bodies in logs | none | process suite |
| Removal of each G-02C1B control | 16 mutants detected | `g02c1b-synthetic-execution-mutation.test.ts` |
| One claim, one effect, no loop; containment; ledger never created; no Host, receipt or adapter | pinned | `g02c1b-synthetic-execution-structure.test.ts` |

## 9. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02C1B-R1 | The ledger is not anchored against rollback: restoring it re-enables consumed capabilities. The synthetic record's exclusive name catches this for the synthetic effect only | Founder (anchoring) |
| G02C1B-R2 | Separate ledgers are separate consumption domains | deployment rule |
| G02C1B-R3 | Stranded `claimed` rows cannot be enumerated or classified `outcome-unknown` with the current ledger API | G-02C1C |
| G02C1B-R4 | Between the directory identity check and the exclusive create, a local attacker able to rename directories inside the executor's private area could redirect the create; the final component is never followed | reference only |
| G02C1B-R5 | `completed` is the executor's own observation of a local file, not external settlement and not authenticated evidence | G-02C1C |
| G02C1B-R6 | Fault injection is configuration-driven; a reference configuration that enables it makes the executor kill itself at that point | reference only |
| G02C1A-R1 … R9, G02B-R*, G02C0-R* | Unchanged | as before |
