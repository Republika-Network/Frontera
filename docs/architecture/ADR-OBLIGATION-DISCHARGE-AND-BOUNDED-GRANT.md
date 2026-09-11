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

A required, unverified obligation prevents **grant issuance**. It does not
rewrite the decision. The decision remains exactly what the policy concluded —
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
   obligation `verified`).
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

A grant past `expiresAt` is expired **when read**, deterministically, from the
clock — never "when a sweeper gets to it". A sweeper may exist for provider
enforcement and for housekeeping, and it is an optimization: correctness never
depends on it having run. This matches how every lifecycle check in the codebase
already treats expiry.

### 7. Obligation state and grant binding are evidence subjects

Both enter the existing `EvidenceBundle` machinery as first-class subjects under
the existing disclosure policies, so "why was this allowed" and "why was this
withheld" are answerable from the same bundle by the same verification digest.

## Hard invariants

1. A grant's scope ⊆ its decision's evaluated scope.
2. A grant's lifetime ⊆ any bound its decision set.
3. A grant bound to a decision that did not allow is not issued.
4. A required obligation that is not `verified` blocks issuance, never the
   decision.
5. A discharge that cannot be verified is not `verified`.
6. Binding verification happens inside the store transaction that issues.
7. Expiry is derived from the clock at read time; no job is load-bearing.

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
| Enforce the binding outside the store transaction | a check against a world that has since moved; the repository already rejected this once, for reservation capacity |
| A background expiry sweeper as the source of truth | correctness would depend on a job having run; expiry must be derivable from the clock at read time |
