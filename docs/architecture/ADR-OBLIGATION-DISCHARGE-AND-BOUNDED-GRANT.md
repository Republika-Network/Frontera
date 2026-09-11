# ADR: Obligation discharge and decision-bound grants

- Status: accepted
- Revised: obligation lifecycle semantics clarified — the state set is six and
  closed (`rejected` removed, having existed only in a diagram no prose
  defined), the legal transition graph, satisfaction semantics, layer-D
  ownership of `required`, obligation expiry and transition-record semantics are
  now stated normatively in §1, §2 and §6. The lifecycle half of this ADR is
  implemented; the decision-bound grant half (§4, §5) is architecture only and
  **no implementation has been performed** for it.
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

**Six states, one closed set, no branching, no parallelism, no assignment.**

```
required   ──▶ pending       required   ──▶ waived       required   ──▶ expired
pending    ──▶ discharged    pending    ──▶ waived       pending    ──▶ expired
discharged ──▶ verified                                  discharged ──▶ expired

verified · waived · expired  ──▶  no outgoing transition (terminal)
```

The adjacency above is the complete graph: eight legal transitions between six
states, and nothing outside it is legal.

It is written as an adjacency list rather than as a box-and-arrow drawing
deliberately. An earlier revision of this ADR drew the lifecycle as ASCII art
whose geometry disagreed with its own prose — the drawing carried a seventh
node, `rejected`, that no sentence in this document or in
`TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` ever defined, while the prose beside
it said "six states". An implementation that read the drawing rather than the
words arrived at a seven-state lifecycle, an invented distinction between an
unverifiable discharge and a refuted one, and a transition the drawing did not
contain. The ambiguity was structural, so the fix is structural: the normative
statement of this lifecycle is the two tables below, and any future diagram must
be checked against them rather than the other way round.

#### The six states

| state | meaning | terminal | satisfies a blocking obligation |
| --- | --- | --- | --- |
| `required` | the obligation has been declared as a consequence or condition of an authorization | no | **no** |
| `pending` | the obligation is active and awaits valid discharge | no | **no** |
| `discharged` | a discharge observation has been supplied for the obligation, but it has not yet been successfully verified | no | **no** |
| `verified` | the discharge has been validly verified | **yes** | yes |
| `waived` | an authorized waiver has validly removed the requirement to discharge the obligation | **yes** | yes |
| `expired` | the obligation's declared deadline passed before it reached a satisfying terminal state | **yes** | **no** |

Satisfying and terminal are different properties and must not be read as one.
Two states satisfy — `verified` and `waived` — and both are terminal. Three are
terminal — those two and `expired` — so `expired` is terminal *and*
unsatisfying, which is the combination a deployment must be able to see: the
condition can no longer be met, and it was not met. `required`, `pending` and
`discharged` are neither terminal nor satisfying. `discharged` not satisfying is
the whole substance of §2.

There is no state for a verification attempt that failed. See §2.

#### The legal transitions

| from | to | occurs when |
| --- | --- | --- |
| `required` | `pending` | the obligation becomes active |
| `required` | `waived` | an authorized waiver is validly recorded |
| `required` | `expired` | the declared deadline passes (§6) |
| `pending` | `discharged` | a discharge observation is supplied |
| `pending` | `waived` | an authorized waiver is validly recorded |
| `pending` | `expired` | the declared deadline passes (§6) |
| `discharged` | `verified` | the supplied discharge is validly verified |
| `discharged` | `expired` | the declared deadline passes (§6) |

`verified`, `waived` and `expired` have **no** outgoing transition. A terminal
obligation is never reopened, and an observation that would reopen one is
refused rather than applied — illegal transitions fail safely, leaving the
obligation exactly as it was.

#### `required` is a Layer D state, not a Layer B declaration

`required` is a real state of this lifecycle, managed by layer D, and it is the
state every obligation instance begins in.

The division is exact. **Layer B declares that an obligation is required** — a
policy concludes that this authorization carries this condition, which is what
`PolicyObligation` and `EnterpriseAccessObligation` already record, immutably and
without state. **Layer D materializes the resulting obligation instance in state
`required` and manages it from there**, transitioning it deterministically into
`pending` as the obligation becomes active, and onward through the table above.

This is written down because an implementation got it wrong in exactly the way
the old diagram invited: it described `required` as "the declared state Layer B
hands over" and counted only the remaining states as layer D's, in order to
reconcile a seven-node drawing with a six-state prose. That reconciliation is
void. `required` is one of the six, it is layer D's, and it has three outgoing
transitions — which is not something a declaration outside a lifecycle can have.

#### What a transition carries

Every lifecycle transition must be deterministic, inspectable and auditable.

Transitions caused by a discharge or by its verification carry the
corresponding discharge and provenance record: who or what discharged the
obligation, when, with what reference, and — where the obligation type admits
one — a `DischargeProof` hash-chained in the same style as `EvidenceProof`,
`ApprovalProof` and `EnforcementProof` already are.

Transitions **not** caused by a discharge — activation (`required → pending`),
waiver, and expiry — carry their own transition provenance and do **not**
require a `DischargeRecord`. An earlier revision of this ADR said "every
transition carries a `DischargeRecord`", which read literally would require
manufacturing a discharge record for an activation that discharged nothing and
for an expiry that is the absence of a discharge. A fabricated record is worse
than an absent one: it attests to an act nobody performed.

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

**A failed or unverifiable verification attempt leaves the lifecycle state as
`discharged`.** It is not a state of its own and does not create one. The
attempt may produce verification and audit information — what was checked, by
what, when, and why it did not verify — and that information is recorded; the
lifecycle does not move. This holds whatever the reason the verification did not
succeed: no independent confirmation was available, the confirming party
declined, the discharge referenced something that could not be resolved, or the
evidence was too old to be accepted under the verification rule that applies to
it. All of them are the same lifecycle fact — *this obligation is not
`verified`* — and a blocking obligation in `discharged` withholds exercise
exactly as one in `required` does.

Rejected: collapsing `discharged` and `verified`. The distinction is the whole
difference between "the requester says it watermarked the content" and "the
provider says so".

Rejected: a separate state for a refuted discharge. It would require this ADR to
distinguish "nobody could confirm it" from "the confirming party said no", and
that distinction changes no outcome anywhere in the lifecycle — both leave the
obligation unsatisfied, both withhold exercise, and both are already fully
described by `discharged` plus the verification record. A state whose only
consequence is identical to an existing state's is not a state; it is a field on
the record that explains it. Should a deployment ever need the two to diverge in
*consequence*, that is a new decision and a new ADR, not a seventh member
smuggled into a set this ADR calls closed.

### 3. Blocking obligations gate the grant, never the decision

A required obligation that is not satisfied — that is, one in any state other
than `verified` or `waived` — prevents **grant issuance**. It does not rewrite
the decision. The decision remains exactly what the policy concluded —
`approval_required`, say — and the evidence shows a decision that concluded X
and a grant that was withheld because obligation Y was not discharged.

Rejected: letting D narrow B's conclusion. It would erase the distinction
between "policy said no" and "policy said yes, conditionally, and the condition
was not met" — which is precisely the distinction an auditor needs, and the one
the existing `conditional` outcome in `EnterpriseAccessDecision` already
anticipates.

### 4. A grant is derived from a verified decision, and is attenuation-only

`issueGrant` gains an optional decision binding. When present:

1. The referenced decision is **read** from the Governance Store, not trusted.
2. It must have concluded `allow` (or `conditional` with every blocking
   obligation satisfied — `verified` or `waived`, per §1).
3. The grant's resource must be the decision's resource identity.
4. The grant's scope must be a subset of the evaluated scope.
5. The grant's `expiresAt` must not exceed any bound the decision set.
6. All of it inside the store's own transaction, against the records read there
   — the same commit-boundary discipline
   `ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §3 established for
   `acquireReservation`, so no check is performed against a world that has since
   moved.

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

### 6. Expiry is a state, not a background job

This holds for obligations and for grants, and the two are stated separately
because they expire against different deadlines.

**An obligation** may declare an optional `expiresAt`. The deadline belongs to
the obligation *requirement* — the declaration a policy or an operator wrote —
and it must come from trusted policy or operator configuration. It **must never**
come from caller-controlled request data: a requester able to set, extend or
remove the deadline on its own obligation has been handed the obligation.

Against an explicit, injected clock, and evaluated when the obligation is read:

```
if currentTime >= obligation.expiresAt
   and state ∈ { required, pending, discharged }
then state → expired
```

An obligation that declares no `expiresAt` never transitions to `expired`.
Expiry **never** changes `verified` or `waived`: a satisfied obligation stays
satisfied, and a deadline passing afterwards is not a reason to withdraw a
condition that was met.

**Obligation expiry is not discharge staleness, and the two must not be
conflated.** Expiry asks whether the obligation's own deadline has passed.
Whether a particular piece of discharge evidence is fresh enough to be believed
is a *verification* question, governed by whatever trusted verification rule
applies to that evidence, and its answer is the one §2 gives: evidence too old
to be accepted simply fails verification, and the obligation remains
`discharged`. Reinterpreting proof freshness as a lifecycle deadline would let
an obligation with no deadline expire, which this section forbids.

**A grant** past its own `expiresAt` is expired **when read**, deterministically,
from the clock — never "when a sweeper gets to it". A sweeper may exist for
provider enforcement and for housekeeping, and it is an optimization:
correctness never depends on it having run. This matches how every lifecycle
check in the codebase already treats expiry.

### 7. Obligation state and grant binding are evidence subjects

Both enter the existing `EvidenceBundle` machinery as first-class subjects under
the existing disclosure policies, so "why was this allowed" and "why was this
withheld" are answerable from the same bundle by the same verification digest.

## Hard invariants

1. A grant's scope ⊆ its decision's evaluated scope.
2. A grant's lifetime ⊆ any bound its decision set.
3. A grant bound to a decision that did not allow is not issued.
4. A required obligation that is not satisfied — in any state other than
   `verified` or `waived` — blocks issuance, never the decision.
5. A discharge that cannot be verified is not `verified`; the obligation
   remains `discharged`, and no other state is created for the attempt.
6. Binding verification happens inside the store transaction that issues.
7. Expiry — of an obligation against its declared `expiresAt`, and of a grant
   against its own — is derived from the clock at read time; no job is
   load-bearing. An obligation that declares no deadline never expires, and
   expiry never disturbs `verified` or `waived`.
8. An obligation's deadline comes from trusted policy or operator
   configuration, never from caller-controlled request data.

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
| A seventh state for a refuted discharge | it changes no outcome: a refuted discharge and an unconfirmed one both leave the obligation unsatisfied and both withhold exercise, so the difference belongs on the verification record, not in a set this ADR calls closed |
| Model obligation expiry as discharge staleness | it would let an obligation that declares no deadline expire, and would make a *verification* question — is this evidence fresh enough to believe? — into a lifecycle transition; §2 already answers it, and the answer is that the obligation stays `discharged` |
| Treat self-reported discharge as verified | the beneficiary attesting to their own compliance is the self-assertion defect from `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`, one layer over |
| Make the decision binding mandatory immediately | breaks every current issuance path on upgrade; `report` posture exists to turn that into a list |
| Enforce the binding outside the store transaction | a check against a world that has since moved; the repository already rejected this once, for reservation capacity |
| A background expiry sweeper as the source of truth | correctness would depend on a job having run; expiry must be derivable from the clock at read time |
