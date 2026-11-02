# Credential Lifecycle — State Machine (PROPOSED)

The credential lifecycle (D5) is the **only** writer of credential state. It is a new entity, distinct
from `AssuranceAssessmentStatus`, from the GOV-01 commercial-authorization axis, from FV
`SovereignAssetStatusValue`, and from XRPL Credential existence.

## 1. States

| State | Meaning | Terminal |
|---|---|---|
| `CANDIDATE` | Registered integration under baseline evaluation; never presented as conformant | No |
| `ACTIVE` | All critical requirements have fresh corroborated passes; no confirmed critical violation | No |
| `SUSPENDED` | Protective hold; conformance not currently asserted; recoverable | No |
| `REVOKED` | Permanently withdrawn; never reactivates | **Yes** |
| `EXPIRED` | Credential term ended; renewal issues a new `credentialId` | **Yes** |

## 2. Transitions

| # | From → To | Trigger | Automatic? | Human approval |
|---|---|---|---|---|
| T1 | ∅ → CANDIDATE | Integration registered with valid testing authorization | yes | — |
| T2 | CANDIDATE → ACTIVE | Initial eligibility (§3) | engine proposes | **2 humans** (issuance) |
| T3 | CANDIDATE → EXPIRED | Not activated within 30 days (proposed) | yes | — |
| T4 | ACTIVE → SUSPENDED | SR-1 … SR-5 ([profile §5](CONFORMANCE_PROFILE_DRAFT.md#5-suspension-rules)) | **yes, immediate** | none (protective) |
| T5 | SUSPENDED → ACTIVE | Reinstatement ([profile §6](CONFORMANCE_PROFILE_DRAFT.md#6-reinstatement-rules)) | yes for non-violation reasons | 2 humans after `CRITICAL_VIOLATION_CONFIRMED` |
| T6 | SUSPENDED → REVOKED | Unresolved > 30 days; or confirmed evidence forgery / intentional bypass; or platform request | yes (timeout) / no | 2 humans for non-timeout reasons |
| T7 | ACTIVE → REVOKED | Legal / contractual termination, platform request | no | **2 humans** |
| T8 | ACTIVE/SUSPENDED → EXPIRED | `credentialValidUntil` reached (proposed term 90 days) | yes | — |

**Prohibited transitions** (enforced by store triggers, as in `sovereign_status_history_forward_only`):
REVOKED → *, EXPIRED → *, SUSPENDED → CANDIDATE, ACTIVE → CANDIDATE, any transition with
`stateVersion ≠ previous + 1`, any automatic transition into REVOKED except the T6 timeout, any
transition into ACTIVE whose evaluation cites evidence older than the profile freshness window.

## 3. Initial activation eligibility (T2)

1. Integration version registered; `integrationDigest` matches what ≥ 2 validators observe (G08).
2. Every critical requirement has `VERIFIED_SUCCESS` within its window, from ≥ k distinct operators.
3. No open `UNCONFIRMED_VIOLATION` or `CONFLICTING` result.
4. Profile version supported and not retired; SDK version within range.
5. Optionally ([CC-D-08](DECISION_REGISTER.md#cc-d-08)): reference to a completed Assurance assessment
   `{assessmentId, assessmentDigest}` for the organization. This is **not** required by the profile and
   does not depend on rn.sv commercial authorization, which remains NO-GO.
6. Two AUTH-03 human decisions bound to the exact issuance digest.

## 4. Freshness and heartbeat

| Condition | Rule |
|---|---|
| Evidence expiry | Each requirement's freshness window (profile §3). Lapse → SR-2 after grace `g`. |
| Validator heartbeat | Each validator signs a heartbeat ≤ every 60 s (pattern: witness monitor probe ≤ 60 s). Missing 5 min → validator `unhealthy`; not counted toward k. |
| Coordinator cannot get fresh evidence | Fail closed: SR-2 / SR-4 → SUSPENDED (never stays ACTIVE silently, never REVOKED automatically). |
| Profile version change | Credentials stay bound to their profile version. When a version is retired, SR-5 suspends after a published deadline; re-credentialing creates a new credential. |
| Integration change | A new `deploymentDigest` = a new `IntegrationVersion` = a new CANDIDATE credential. The old credential is suspended by G08 if the old digest is no longer what is deployed. |

## 5. Security invariant and how it is enforced

> **A credential must not remain ACTIVE once the system has accepted a confirmed critical violation.**

Mechanism (to be proven by tests in RN-CONFORM-02):

1. The engine's evaluation and the resulting T4 transition commit in **one atomic transaction**
   (precedent: ASSURE-SEC-01E atomic completion with finding events). There is no state in which a
   `VERIFIED_FAILURE` evaluation is persisted and the credential is still ACTIVE.
2. The status registry derives assertions only from the committed head; it never caches an ACTIVE
   assertion across a newer `stateVersion`.
3. A store trigger refuses inserting an evaluation with `VERIFIED_FAILURE` on a critical requirement
   unless the same transaction inserts the T4 transition (or the credential is already non-ACTIVE).
4. Blockchain anchoring is downstream and asynchronous; it can never delay or roll back T4.
5. Residual exposure is bounded by assertion `validUntil` for offline verifiers (proposed ≤ 15 min) and is
   zero for online nonce-bound verification.

## 6. Appeals and operator intervention

* A platform may appeal a suspension. Appeals never auto-reactivate; they trigger an expedited
  re-challenge by operators not involved in the confirming observations, plus human review.
* An operator override that reactivates against a standing `VERIFIED_FAILURE` is **prohibited** by the
  lifecycle. The only path back to ACTIVE is fresh corroborated evidence (T5).
* Every human decision is recorded as a `HumanDecisionRef` in the transition, which is hash-chained and
  signed (precedent: `authority-event-stream/event-chain.ts`).

## 7. Proposed SLOs (targets, not achieved)

| SLO | Target |
|---|---|
| Confirmation → SUSPENDED committed | ≤ 60 s p99 |
| SUSPENDED → visible to online verifiers | ≤ 5 s after commit |
| Max staleness of an offline ACTIVE assertion | ≤ 15 min |
| Single-report → investigation complete (`T_confirm`) | ≤ 30 min |
| Critical-requirement re-check interval | ≤ 24 h |
| Anchor of a transition digest | ≤ 1 h (batched), non-blocking |
