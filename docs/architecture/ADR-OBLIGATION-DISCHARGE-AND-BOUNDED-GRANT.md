# ADR: Obligation discharge and decision-bound grants

- Status: accepted (architecture only — **no implementation performed**)
- Related: `ADR-POLICY-OBLIGATION.md` (the declarative contract this completes),
  `ADR-ACCESS-GRANT.md`, `ADR-ACCESS-DECISION.md`, `ADR-ACCESS-LIFECYCLE.md`,
  `ADR-GRANT-REVOCATION.md`, `ADR-DURABLE-GRANTS-REVOCATION.md`,
  `ADR-AUTHORITY-CONTROL-LAYERING.md`
- Scope: `packages/obligation-lifecycle` (new), `packages/access-grant`,
  `src/features/obligation-runtime` (new),
  `src/enterprise/obligation-governance` (new),
  `src/enterprise/access-governance/`
- **Two closures in one lifecycle.** Not a workflow engine. Not an approval
  router. Not a scheduler. Not a notification system. No Protocol change.

## Context: two measured holes in the middle of the lifecycle

The target lifecycle is `… → policy evaluation → obligations if required →
bounded grant → action → …`. Both edges around "obligations" are missing.

**Hole 1 — obligations are declarations with no lifecycle.**
`PolicyObligation` (`domain-policy-pack-runtime`) and
`EnterpriseAccessObligation` (`@aoc-enterprise/access-obligation`) both describe,
correctly and immutably, a condition attached to a decision. The entire runtime
treatment of them is `PolicyObligationService.collect()`, which deduplicates
matched-rule obligations in first-seen order and partitions them into
`required` / `optional`. There is no state, no discharge, no record of who
discharged one, no proof, and nothing that consults discharge before anything
proceeds. `require-approval`, `require-mfa`, `record-usage`,
`watermark-content`, `require-acceptance` are, today, statements that the
platform makes and never checks.

**Hole 2 — decision and grant are joined by an unverified string.**
`AccessGrantService.issueGrant(context, organizationId, request)` takes
`decisionRef: string`. Nothing verifies that the referenced decision exists,
that it concluded `allow`, that the grant's resource is the decision's resource,
that the grant's scope lies within the scope the decision evaluated, or that
`expiresAt` respects any bound the decision set. A caller holding grant-issuance
rights can mint a grant citing a decision that denied, or a decision for a
different resource, or no decision at all.

Both holes have the same shape: an immutable record correctly describes
something, and nothing enforces the relationship the record describes.

## Decision

### 1. An obligation gets a closed lifecycle and nothing more

```
required ──▶ pending ──▶ discharged ──▶ verified
   │            │             │
   ├──────────▶ waived        └──▶ rejected
   └──────────▶ expired
```

Six states, one closed set, no branching, no parallelism, no assignment. Every
transition carries a `DischargeRecord`: who or what discharged it, when, with
what reference, and — where the obligation type admits one — a
`DischargeProof` hash-chained in the same style as `EvidenceProof`,
`ApprovalProof` and `EnforcementProof` already are.

### 1a. Every obligation declares *when* it can be satisfied

A single "required obligations block the grant" rule is wrong, and the existing
obligation vocabulary shows why immediately. `record-usage` cannot be discharged
until a grant has been exercised. `read-only`, `no-download` and `time-limit`
are continuing conditions on access that has already started. Gating issuance on
any of them is a deadlock: the grant waits for a discharge that can only happen
after the grant.

So `timing` is a required, closed field on every obligation:

| timing | satisfied | checked at |
| --- | --- | --- |
| `precondition` | before access | grant issuance |
| `continuing` | throughout access | every grant read and every provider credential request |
| `post_action` | after the action | usage recording and grant closure |

`require-approval`, `require-mfa` and `require-acceptance` are preconditions.
`read-only`, `no-download` and `time-limit` are continuing. `record-usage` is
post-action. `watermark-content` is a precondition on the *provider
configuration*, not on the requester.

**Only `precondition` obligations gate issuance.** A `continuing` obligation
that is not *configured* blocks issuance — there is no point issuing a
`no-download` grant a provider cannot enforce — but its satisfaction is a
property of enforcement, not a discharge to wait for. A `post_action`
obligation that is unmet after the fact is a compliance finding recorded in
evidence, never a retroactive invalidation of a grant that was correctly issued.

### 1b. A valid waiver satisfies the gate

`waived` is a real terminal state, so it must actually terminate something. The
gate is **verified-or-validly-waived**, not `verified` alone; otherwise a
legitimately waived obligation would leave its grant permanently unissuable and
`waived` would be a state no deployment could ever use.

A waiver is valid when it was recorded by an actor with authority to waive that
obligation type, carries a reason, and has not expired. An invalid or expired
waiver is not a waiver, and the gate is unsatisfied.

**This is emphatically not a workflow engine.** There is no routing, no
assignment, no escalation, no reminder, no SLA, no scheduling, no notification.
Frontera records that an obligation was discharged and whether that discharge
verifies. Who was asked, how they were reached, and what happens if they are
slow is the deployment's business, and Frontera would be wrong to own it.

### 2. `verified` is not `discharged`

An obligation reported as discharged by the actor who benefits from it is
`discharged`. It becomes `verified` only when something independent of that
actor confirms it — an Approval Runtime proof, a provider adapter's
acknowledgement, an attested context fact. A discharge that cannot be verified
stays `discharged` and is treated by policy as it declared.

Rejected: collapsing the two. The distinction is the whole difference between
"the requester says it watermarked the content" and "the provider says so".

### 3. Blocking obligations gate the grant, never the decision

A required `precondition` obligation that is neither verified nor validly waived
prevents **grant issuance**. It does not rewrite the decision. The decision remains exactly what the policy concluded —
`approval_required`, say — and the evidence shows a decision that concluded X
and a grant that was withheld because obligation Y was not discharged.

Rejected: letting D narrow B's conclusion. It would erase the distinction
between "policy said no" and "policy said yes, conditionally, and the condition
was not met" — which is precisely the distinction an auditor needs, and the one
the existing `conditional` outcome in `EnterpriseAccessDecision` already
anticipates.

### 4. A grant is derived from a verified decision, and is attenuation-only

**Which record is authoritative, stated exactly.** `GovernanceEvaluationRecord`
in the Governance Store is the binding target — it is the only decision this
platform actually persists. `EnterpriseAccessDecision`
(`@aoc-enterprise/access-decision`) is a contract *shape* that the Governance
Store does not persist and that no production path writes today, so binding
against it would mean binding against a record that does not exist.

That choice has consequences the earlier draft glossed over, and each needs a
stated mapping rather than an assumed one:

| check | field on `GovernanceEvaluationRecord` | status |
| --- | --- | --- |
| decision exists | `evaluationId` / `decisionId` | **present** |
| decision allowed | `status: KernelDecisionStatus` — `allowed` \| `denied` \| `approval_required` \| `indeterminate` | **present**, and it is *not* the `allow`/`deny`/`conditional` vocabulary; `allowed` binds, `approval_required` binds only with its precondition obligations satisfied, `denied` and `indeterminate` never bind |
| resource identity | — | **absent.** The record carries no resource object |
| evaluated scope | — | **absent** |
| lifetime bound | `evaluatedAt` only | **absent** |

Three of the five checks therefore have no field to read. Rather than invent an
undocumented translation, the binding is defined on what exists and the rest is
made to exist explicitly:

1. **Checks 1–2 bind today**, against `status`, with the `KernelDecisionStatus`
   vocabulary named above and no translation to a second enum.
2. **Checks 3–5 require an additive `GovernanceDecisionBoundsRecord`** — resource
   identity, evaluated scope, and an optional `notValidAfter` — written by the
   same commit that writes the evaluation record, as a sibling child record in
   the style `GovernanceTraceRecord` already uses. It is additive, so existing
   aggregates and digests are unaffected and a record written before it existed
   simply has no bounds to check against.
3. **A grant may bind only to a decision that carries bounds.** A decision
   without them is not a weaker binding; it is an unbindable one, and
   `decisionBinding: 'require'` refuses it.

**Atomicity across two stores, since there is only one store per fact.** The
Governance Store and the Access Grant Store are genuinely independent — separate
implementations, separate `new Database(path)` connections, and in general
separate files. There is no transaction that spans them, and claiming the check
happens "inside the store's own transaction" was wrong.

The protocol instead is read-verify-pin-issue:

1. Read the decision record and its bounds from the Governance Store, capturing
   the `resultDigest` and the bounds digest.
2. Verify checks 1–5 against what was read.
3. Issue the grant inside the **Access Grant Store's** own transaction, writing
   the pinned `decisionRef`, `resultDigest` and bounds digest onto the grant row.
4. The write is conditional on those digests: the grant records exactly which
   decision state authorized it.

Because governance evaluation records are append-only and immutable, a pinned
digest cannot be invalidated by a later write — which is what makes a single-store
transaction unnecessary here, as opposed to the reservation case in
`ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §3, where the contended state is
mutable and a same-transaction re-read is the only safe option. The distinction
is immutability, and it is the reason the weaker protocol is sufficient rather
than a concession.

**Attenuation only.** A grant ⊆ its decision, exactly as a `DelegationGrant` ⊆
its source in Authority Graph. Same rule, same reason, now applied one layer
down.

### 5. The binding is optional, so existing behaviour is preserved exactly

`decisionRef` as a free string remains valid and behaves identically. The
verified binding is a new, additional field. A deployment that does not adopt it
sees no change — the pattern every optional Kernel port in this repository
already follows.

A configuration posture mirrors the context migration:
`grants.decisionBinding: 'off' | 'report' | 'require'`. `report` records, in
evidence, every grant issued without a verified binding, so an operator gets a
list rather than an outage.

### 6. Expiry is a state, not a background job — but a credential must be capped at issue

A grant past `expiresAt` is expired **when read**, deterministically, from the
clock — never "when a sweeper gets to it". A sweeper may exist for provider
enforcement and for housekeeping, and it is an optimization: correctness never
depends on it having run. This matches how every lifecycle check in the codebase
already treats expiry.

**Expiry-at-read is necessary and not sufficient, and the gap is real today.**
It bounds what Frontera will *answer*; it does not bound a credential a provider
has already minted. `AccessGrantService.requestProviderCredential` currently
calls `assertActive(grant.status)` — a status check, not an expiry check — and
then forwards `input.requestedDurationSeconds` to Pinata verbatim, never
comparing the returned `result.detail.expiresAt` against `grant.expiresAt`. A
signed URL requested shortly before a grant expires therefore stays usable after
it, and since no further Frontera read is involved, expiry-at-read can never
observe it. Declaring sweepers non-load-bearing removes the only other thing
that might have caught it.

So issuance of a provider credential is bounded at the point of issue:

1. The grant must be unexpired **at the instant of the request**, evaluated
   against the clock, not merely `status === 'active'`.
2. The credential's lifetime is `min(requestedDuration, grant.expiresAt − now)`.
3. If the provider returns an `expiresAt` later than `grant.expiresAt`, the
   credential is rejected rather than recorded — a provider that cannot honour
   the cap cannot be relied on to enforce it.
4. If no positive bounded lifetime remains, issuance is refused outright.

This is the one place in this ADR that describes a defect in *existing shipped
code* rather than a gap in a proposed design, and it should be fixed
independently of whether the rest of this architecture is adopted.

### 7. Obligation state and grant binding are evidence subjects

Both enter the existing `EvidenceBundle` machinery as first-class subjects under
the existing disclosure policies, so "why was this allowed" and "why was this
withheld" are answerable from the same bundle by the same verification digest.

## Hard invariants

1. A grant's scope ⊆ its decision's evaluated scope.
2. A grant's lifetime ⊆ any bound its decision set.
3. A grant bound to a decision whose `status` is not `allowed` — or
   `approval_required` with its preconditions satisfied — is not issued.
4. A required **`precondition`** obligation that is neither `verified` nor
   validly `waived` blocks issuance, never the decision. `continuing` and
   `post_action` obligations never gate issuance.
5. A discharge that cannot be verified is not `verified`.
6. A grant records the `decisionRef` and the digests of the exact decision state
   that authorized it; those records are immutable, so the pin cannot be
   invalidated after the fact.
7. Expiry is derived from the clock at read time; no job is load-bearing.
8. A provider credential's expiry never exceeds its grant's, and issuance is
   refused when no positive bounded lifetime remains.

## Consequences

**Gained.** The lifecycle's two missing edges. A structural answer to "was the
condition actually met?". A grant that cannot exceed what authorized it. Two
distinguishable failures — denied, versus allowed-but-conditions-unmet — visible
in the same evidence bundle.

**Not gained, deliberately.** No workflow engine, no routing, no notifications,
no SLA tracking, no escalation, no obligation *scheduling*. No automatic
discharge of any obligation type by Frontera itself — if the platform could
discharge `require-mfa` on its own, it would be performing the control rather
than governing it.

**Costs.** A new store for obligation state. Two new configuration postures.
`issueGrant` gains a transactional read it did not have. Six states that must be
kept closed as obligation types are added.

## Alternatives rejected

| alternative | why not |
| --- | --- |
| Leave obligations declarative | `require-mfa` that nothing checks is a statement the platform makes and never keeps; it is worse than not offering the type |
| Model obligations as a workflow with routing and SLAs | Frontera would own the deployment's process; scope drift directly into the "no workflow engine" boundary |
| Let a blocking obligation flip the decision to denied | erases the audit-critical difference between "policy said no" and "condition unmet"; also contradicts `EnterpriseAccessDecision`'s existing `conditional` outcome |
| Treat self-reported discharge as verified | the beneficiary attesting to their own compliance is the self-assertion defect from `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`, one layer over |
| Make the decision binding mandatory immediately | breaks every current issuance path on upgrade; `report` posture exists to turn that into a list |
| A single transaction spanning both stores | they are separate implementations with separate connections and generally separate files; no such transaction exists to be used |
| Bind against `EnterpriseAccessDecision` | it is a contract shape the Governance Store does not persist and no production path writes; binding against an absent record is not a binding |
| Translate `KernelDecisionStatus` into `allow`/`deny`/`conditional` | an undocumented second enum in the middle of the one check that must be unambiguous |
| Infer resource and scope bounds from the stored result payload | an untyped `Record<string, unknown>` read as if it were a schema; an additive typed bounds record is the honest version |
| Gate issuance on every required obligation regardless of timing | deadlocks `record-usage`, `read-only`, `no-download` and `time-limit`, which cannot be satisfied before the access they describe |
| Require `verified` alone at the gate | makes `waived` a state that terminates nothing and permanently blocks any grant whose obligation was legitimately waived |
| Rely on expiry-at-read to bound provider credentials | a minted signed URL involves no further Frontera read; nothing would observe it |
| A background expiry sweeper as the source of truth | correctness would depend on a job having run; expiry must be derivable from the clock at read time |
