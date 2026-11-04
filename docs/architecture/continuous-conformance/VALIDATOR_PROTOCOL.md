# Validator Protocol — Challenges, Evidence, Corroboration (PROPOSED)

Validators are **witnesses**: they run authorized challenges and sign what they observed. They do not
decide conformance, vote, stake, or earn on-chain rewards. All decisions are taken by the deterministic
engine (D4) and the credential lifecycle (D5). Envelopes are defined in
[INTEGRATION_CONTRACTS.md](INTEGRATION_CONTRACTS.md).

## 1. Validator identity and independence

* Each validator holds its **own Ed25519 key**, generated in its own custody domain. Its public key is
  pinned in the validator registry by a two-person AUTH-03 decision (pattern: witness `enroll`, which
  never rebinds; executor `TrustedExecutor` multi-key list for rotation).
* **Independence is per operator, not per process.** Two processes run by the same operator count as
  one for corroboration. The initial network is Republika-operated plus explicitly authorized federated
  operators ([CC-D-02](DECISION_REGISTER.md#cc-d-02)). Until a second independent operator is
  contracted, any "2-of-2" result is labeled `corroboration: 'single-operator'` and **cannot activate a
  credential outside synthetic demonstrations**.
* Validator states: `enrolled → active ↔ quarantined → revoked`. Auto-quarantine on self-contradiction
  (pattern: X `SourceTrustRegistry`) or on repeated signature/binding defects; release from quarantine
  and revocation need two human decisions.
* **RN-CONFORM-05 clarifications (implemented, synthetic):**
  * *Keys are generations.* A rotation or a quarantine release enrolls a new key generation as its own
    immutable validator identity (`<validatorId>.k<n>`) under the **same** operator; the previous generation
    keeps its key forever (history stays verifiable), is never reassigned, and a quarantined or revoked
    generation never returns. Release from quarantine = new generation + two humans (`validator.enroll`) +
    two humans (`validator.reinstate`) + a requalification challenge.
  * *Only authenticated defects are attributable.* Auto-quarantine counts contradictions and protocol defects
    that can only be produced with the validator's own valid signature (binding, assignment, subject, profile;
    equivocating heartbeats). **Signature failures are not attributed to the claimed validator** — anyone can
    send bytes naming a validator id — so "repeated signature defects" above is read as *authenticated*
    defects only (normative correction).
  * *Heartbeats* are signed in their own domain (`frontera:conformance-validator-heartbeat:v1`), session-bound
    and monotonic; they decide assignability only and can never lift a quarantine.
  * The `corroboration: 'single-operator'` label is **not** yet carried in status assertions; every record is
    synthetic-designated instead. A production status contract must carry an equivalent before CC-D-02 closes.
  See [RN_CONFORM_05_IMPLEMENTATION.md](RN_CONFORM_05_IMPLEMENTATION.md).

## 2. Challenge lifecycle

```
ISSUED ──► DISPATCHED ──► OBSERVED (per validator) ──► CLOSED (window end or quorum)
   │             │                                         │
   └─ EXPIRED ◄──┴──── deadline passed without observation ─┘
```

* `challengeId` is unique; `nonce` is ≥ 32 random bytes and must be echoed in the observation.
* Idempotency: re-dispatching the same `challengeId` returns the same challenge; a validator submits at
  most one observation per `(challengeId, validatorId)`; a second identical submission is a no-op,
  a second *different* submission is recorded as a validator conflict (pattern: FV same-sequence /
  different-digest → `CONFLICT_DETECTED`, latched).
* Deadlines: `deadline - issuedAt ≤ 15 min` for routine checks; investigation challenges ≤ `T_confirm`.
* Scheduling: durable, leased jobs with fencing tokens and bounded retries (pattern: L `OutboxWorker`,
  `RetryPolicy`). No unbounded polling.

## 3. Evidence acceptance (D3)

Each check fails closed with a specific reason code; rejected submissions are retained (append-only)
for audit but never feed evaluation.

| # | Check | Rejection reason |
|---|---|---|
| 1 | Schema closed, all required fields present | `MISSING_FIELD` / `UNKNOWN_FIELD` |
| 2 | `validatorId` known | `UNKNOWN_VALIDATOR` |
| 3 | Validator `active` and `validatorKeyId` valid at `observedAt` | `VALIDATOR_REVOKED` / `VALIDATOR_QUARANTINED` / `KEY_NOT_VALID` |
| 4 | Signature verifies under pinned key, correct domain | `SIGNATURE_MISMATCH` |
| 5 | `challengeId` exists, `challengeNonce` matches, validator was assigned | `CHALLENGE_UNKNOWN` / `CHALLENGE_BINDING_MISMATCH` / `NOT_ASSIGNED` |
| 6 | Subject binding (`platformId`, `integrationId`, `integrationVersion`, `integrationDigest`, `controlId`, `operation`) equals the challenge | `SUBJECT_BINDING_MISMATCH` |
| 7 | `profileId/profileVersion` supported and equal to the challenge; never lower than the credential's | `UNSUPPORTED_PROFILE` / `PROFILE_DOWNGRADE` |
| 8 | `issuedAt ≤ observedAt ≤ submittedAt ≤ deadline + skew(5 s)`; `observedAt ≤ trustedNow + skew` | `CHALLENGE_EXPIRED` / `FUTURE_DATED` |
| 9 | `eventId` unseen; `(challengeId, validatorId)` unseen or byte-identical | `REPLAYED` / `DUPLICATE` (no-op) / `VALIDATOR_CONFLICT` |
| 10 | `evidenceDigest` well-formed; evidence package present in custody store (off-chain) | `EVIDENCE_MISSING` |

**Evidence arriving after suspension** is accepted normally (it may support reinstatement) but cannot
re-activate by itself. **Network partitions:** observations are accepted up to `deadline + skew`; late
observations are recorded as `LATE` and only count for the next window. If partition prevents
corroboration, SR-4 applies (fail closed to SUSPENDED, never to REVOKED).

## 4. Corroboration

For each `(integrationDigest, controlId, window)` the engine computes, over accepted observations from
distinct operators:

| Outcome | Rule |
|---|---|
| `VERIFIED_SUCCESS` | ≥ k conformant, 0 violation |
| `VERIFIED_FAILURE` (confirmed) | ≥ k violation |
| `INSUFFICIENT_CORROBORATION` | < k usable observations, 0 violation |
| `UNCONFIRMED_VIOLATION` | 1 ≤ violations < k → SR-3 investigation |
| `CONFLICTING` | ≥ 1 conformant **and** ≥ 1 violation from different operators → G10; extend to a third operator; if still split, treat as `VERIFIED_FAILURE` only if violations ≥ k, else SUSPEND with `CONFLICTING_EVIDENCE` after `T_confirm` |
| `VALIDATOR_FAILURE` | Observations `error/timeout` attributable to the validator (validator health failing) |
| `PLATFORM_FAILURE` | `unreachable/error` from ≥ k operators on a healthy validator set → counts as missing evidence; repeated → SR-2 |
| `STALE` / `MISSING` | No `VERIFIED_SUCCESS` within the requirement's freshness window |

The violation side is asymmetric on purpose: a single validator can **trigger investigation** but cannot
suspend; failure to complete the investigation suspends (fail closed). This keeps a malicious validator
from arbitrarily revoking a competitor while ensuring a real violation cannot be ignored.

## 5. Challenge catalogue (G01–G10)

All tests run only against **controlled synthetic fixtures** or endpoints with a signed, unexpired
testing authorization. **No Fileverse production testing.**

| Id | Property violated | Challenge procedure (authorized fixture) | Expected outcome | Evidence | Corroboration | Consequence |
|---|---|---|---|---|---|---|
| G01 | Authorization bypass | Attempt covered operation with no / malformed / forged decision | `denied` | Signed observation + request/response digests | k operators | CR-01 → SR-1 |
| G02 | Revocation failure | Obtain authorization; coordinator triggers revocation on fixture; retry at `t0 + P_rev + ε` | `denied` | Two observations (pre/post) with timestamps | k operators | CR-02 → SR-1 |
| G03 | Alternative access path | Exercise each declared in-scope interface (API, UI-backing route, webhook) with unauthorized principal | `denied` on all | Per-interface observations | k operators | CR-03 → SR-1 |
| G04 | Direct storage path | Fetch protected asset by its storage locator without going through enforcement | `denied` / content unavailable | Observation + digest of response (never content) | k operators | CR-04 → SR-1 |
| G05 | Cached authorization | Obtain decision; wait past ceiling; reuse | `denied` | Two observations | k operators | CR-05 → SR-1 |
| G06 | Tenant isolation | Principal of synthetic org A acts on org B resource | `denied` | Observation | k operators | CR-06 → SR-1 |
| G07 | SDK failure mode | Fixture makes authorization dependency unavailable / slow beyond timeout | `fail_closed` | Observation | k operators | CR-07 → SR-1 |
| G08 | Unapproved change | Read deployment/adapter/policy digests from the attested release manifest endpoint; compare | equal to credentialed | Observation with `observedDeploymentDigest` | 2 validators, deterministic compare | CR-08 → SR-1 |
| G09 | Missing monitoring evidence | (Engine-side) required evidence older than window | — | Absence | none (deterministic) | CR-09 → SR-2 |
| G10 | Validator disagreement | (Engine-side) conflicting observations | — | Both observations | ≥ 3 operators to resolve | CR-10 → §4 |

## 6. Evidence preservation and redaction

* Evidence packages (request/response metadata, timing, digests) are stored off-chain in an append-only,
  tenant-scoped custody store (pattern: Assurance store tenant scoping + release custody triggers).
* Packages **never contain protected document content**, keys, bearer tokens or Fileverse `#key=` URL
  fragments (precedent: FV `externalReference` forbids locators). Response bodies are reduced to digests
  and status codes.
* Only digests of transitions (and optionally Merkle roots of evidence digests) may be anchored on a
  public chain. See [XRPL_ANCHORING.md](XRPL_ANCHORING.md).
