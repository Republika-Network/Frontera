# Soberanía Approval Runtime

Recognition Runtime answers "can this action be recognized?" Authority Graph
answers "where did the authority behind this action come from?" Neither one
answers the question that matters once a capability token says an action
needs a human in the loop:

**When an action requires human approval, who can approve it, why can they
approve it, what evidence did they review, what decision did they make, and
can that approval be used to recognize the action?**

That is Approval Runtime's job. Its core thesis:

- **Recognition Runtime** decides whether an action requires approval.
- **Authority Graph** proves who has authority.
- **Approval Runtime** governs the human approval decision.
- **ApprovalProof** explains why the approval counted.

No human approval counts unless it is issued by a recognized approver with
authority, scope, evidence and auditability. This module is not a generic
workflow engine, not a legal system, not an AI agent framework, and it does
not use LLMs to decide approval validity -- every decision is a pure function
of typed records and an injected clock.

## Why Recognition Runtime alone is not enough

Recognition Runtime's `ApprovalPolicy` can tell you an action like
`send_client_follow_up` requires human approval before it proceeds. It has no
model for who is allowed to give that approval, whether that approver still
holds the authority to do so, what evidence they were shown, whether their
own authority was later revoked, or how to stop the same approver from
double-counting toward a quorum. `require_human_approval` is a gate, not a
process -- Approval Runtime is the process behind the gate.

## Why Authority Graph is needed for approval

Recognizing that Victor *submitted* an approval is not the same as proving
Victor *may* approve. An approver's authority to approve a specific action
over a specific resource scope is exactly the kind of provable lineage
Authority Graph already models -- so Approval Runtime asks Authority Graph
the same question Recognition Runtime does, just about the approver instead
of the requester: does a real authority chain justify this actor approving
this action, over this scope, right now? Suggested approval authority
capabilities: `approve_project_action`, `approve_client_communication`,
`approve_financial_action`, `approve_critical_action`.

## ApprovalRequirement vs. ApprovalRequest vs. ApprovalDecision

- **ApprovalRequirement** is policy, defined ahead of time: "actions matching
  `send_client_follow_up` over `project:HMP-14665` need one approval, from
  someone holding `approve_client_communication`, with an email draft
  reviewed." It is reusable across many requests.
- **ApprovalRequest** is one instance of that policy applied to one action:
  "PMFreak's specific attempt to send this specific follow-up, right now,
  needs that approval." It carries its own lifecycle status (`pending` →
  `approved` / `rejected` / `expired` / `revoked` / `cancelled` /
  `superseded`).
- **ApprovalDecision** is one approver's verdict on one ApprovalRequest:
  approved, rejected, changes requested, escalated -- or one of the
  deterministic failure verdicts (`invalid_approver`,
  `insufficient_evidence`, `out_of_scope`, `conflict_of_interest`,
  `quorum_not_met`, `duplicate_approval`) when the attempt itself was not
  admissible.

## ApprovalRequest vs. ApprovalProof

An ApprovalRequest is mutable while open -- more decisions can arrive, and
its status can still change. An **ApprovalProof** is created only once a
request's quorum is actually satisfied: an immutable, hash-chained record of
which decision completed the approval, which evidence was reviewed, and
which Authority Graph decision justified the approver. Recognition Runtime
never looks at the request; it looks at the proof. A request can exist
without a proof (still pending, or never approved); a proof cannot exist
without exactly one completing request and decision behind it.

## ApproverRule vs. ApprovalRequirement

An ApprovalRequirement is attached to one specific request (via the action +
resource scope it was created for) and is the source of truth once a request
exists. An **ApproverRule** is a standing, reusable policy matched by
`actionPattern` / `resourceScopePattern` (supporting a trailing `*` wildcard)
against *any* matching request -- used to resolve candidate approvers (by
actor ID, by role, or by required authority capability) without having to
name every approver on every requirement up front. `ApproverResolutionService`
consults both: the requirement's own explicit approvers/roles/capability,
and any ApproverRule matching the request's trust domain, action and scope.

## How approvers are resolved

`ApproverResolutionService.resolveApprovers` collects candidates from the
requirement's `requiredApproverActorIds` / `requiredApproverRoleIds`, from
any matching `ApproverRule`, and from any explicit candidates the caller
supplies. Each candidate is then checked in order: is it recognized (not
rogue, not unknown, not suspended/revoked)? Does segregation of duties
exclude it (requester or target of the action)? Does it hold the required
authority capability, per Authority Graph? Only actors who are recognized
*and* not excluded *and* (when a capability is required) authorized survive
into `validApproverActorIds`; everyone else lands in
`rejectedCandidateActorIds` with a reason.

## How approver authority is verified

When a requirement (or a matching ApproverRule) names a
`requiredAuthorityCapability`, Approval Runtime calls Authority Graph through
`ApprovalAuthorityGraphIntegration.verifyAuthority` with that capability as
the action and the request's resource scope. Authority Graph's answer is
consumed directly: `scope_expansion_detected` becomes `approval_out_of_scope`,
`ancestor_revoked` becomes `approval_revoked`, `ancestor_expired` becomes
`approval_expired`, anything else invalid becomes `invalid_approver`. Victor
can approve `send_client_follow_up` for `project:HMP-14665` because Authority
Graph proves that grant; he cannot approve the same action for
`project:GCH-15992` because Authority Graph does not.

## How evidence requirements work

`ApprovalRequirement.evidenceRequirements` names the `ApprovalEvidenceType`s
(e.g. `email_draft`, `project_context`, `authority_proof`,
`recognition_decision`) a decision must include to approve. `ApprovalEvidencePolicy`
compares the required, `required: true` types against the types actually
present on `ApprovalDecisionAttempt.evidenceReviewed` -- deterministic set
membership, no interpretation of the evidence's content. Missing required
evidence fails with `approval_insufficient_evidence`, and only ever blocks an
`approved` attempt (rejecting or escalating does not need full evidence).

## How segregation of duties works

When `requiresSegregationOfDuties` is set, `SegregationOfDutiesPolicy` blocks
an approver who is either the request's `requestedByActorId` or its
`targetActorId` -- PMFreak Closure Agent can never approve its own requested
action. It deliberately does **not** bar `principalActorId`: that field names
who an agent's authority traces back to (the human "on behalf of" whom an
agent acts), not a beneficiary of the approval itself. Barring the principal
would block exactly the human-in-the-loop review this policy exists to
enable -- Victor approving an email PMFreak drafted on his behalf.

## How quorum / dual approval works

`ApprovalRequirement.minimumApprovals` sets how many *distinct* approvers
must approve before a request is complete. `QuorumPolicy` counts distinct
approver IDs across prior `approved` decisions plus the current attempt; the
same approver never counts twice (`DuplicateApprovalPolicy` rejects a second
`approved` attempt from an approver who already approved). A dual-approval
request (e.g. Project Manager + Finance Approver) stays `pending` -- and
produces no proof -- after the first valid approval, and only transitions to
`approved` with a proof once the second, distinct approval lands.

## How expiration works

Every check is driven by the injected clock, never wall-clock time.
`ExpirationPolicy` compares `ApprovalRequest.expiresAt` against `now`;
`ApprovalExpirationService` additionally sweeps pending requests
(`expirePendingRequests`) and lazily expires a single request or proof on
demand (`expireRequestIfNeeded`, `expireProofIfNeeded`). An expired request
cannot receive a new decision; an expired `ApprovalProof` fails
`verifyApprovalProof` even though its stored `status` may not have been
swept to `'expired'` yet -- expiry is always re-checked against the current
`now` before a proof is trusted.

## How revocation works

`ApprovalRevocationService` revokes an `ApprovalRequest` (blocking further
decisions) or an `ApprovalProof` (blocking future reuse for recognition)
independently -- revoking a proof does not require revoking the request that
produced it, and vice versa. Revocation never deletes history: the ledger
entries recorded before revocation (the original `approval_requested`,
`approval_approved`, `approval_proof_created`, ...) remain exactly as they
were: only a new `approval_revoked` event is appended, and future use is
blocked going forward.

## How ApprovalProof is generated

`ApprovalProofService.createProof` builds a deterministic SHA-256 digest
(the same recursive key-sorting `stableStringify` approach used by
Recognition Runtime and Authority Graph) over the approval request, decision,
approver, action, resource scope, evidence hashes and any Authority Graph
proof reference -- chained to the previous proof's hash the same way the
ledger chains events. Identical inputs always produce the identical
`proofHash`; changing the approver, the evidence, or the decision changes it.
A proof is created exactly once, when quorum is satisfied, and associates
with the single decision that completed it.

## How ApprovalLedger works

`ApprovalLedger` is an append-only, hash-chained record of every
`ApprovalEvent` (`approval_requested`, `approvers_resolved`,
`approval_approved`, `approval_rejected`, `approval_changes_requested`,
`approval_escalated`, `approval_expired`, `approval_revoked`,
`approval_proof_created`, `approval_verified`, `approval_verification_failed`).
Each event's hash folds in the previous event's hash, so the trail can be
replayed and verified; it can be queried by trust domain, approval request,
decision, or proof.

## How Recognition Runtime integrates with Approval Runtime

Recognition Runtime never imports this module's types. It defines a local,
structurally-typed `ApprovalRuntimeIntegration` (mirroring the existing
`AuthorityGraphIntegration` pattern) with one required method,
`verifyApprovalForAction`, and one optional method,
`createApprovalRequestForDecision`. `ApprovalRuntime`'s own methods happen to
match those shapes field-for-field, so an `ApprovalRuntime` instance can be
passed straight into `createAocRecognitionRuntime(ctx, policies, authorityGraph,
approvalRuntime)` with no adapter.

The integration is opt-in and strictly additive to an already-viable
decision:

- Approval is only ever evaluated once Recognition's own policy chain (and
  Authority Graph, if configured) already produced `require_human_approval`
  -- never for a denial, a missing-evidence result, or an already-clean
  `allow`.
- A valid `ApprovalProof` upgrades the decision to `allow`.
- A missing approval leaves it `require_human_approval`, unchanged.
- An invalid, revoked, or segregation-violating approval becomes
  `policy_violation`.
- An expired or quorum-incomplete approval stays `require_human_approval`,
  with a reason code identifying why (`APPROVAL_EXPIRED`,
  `APPROVAL_QUORUM_NOT_MET`).
- Approval can never override an unrecognized actor, an invalid/expired/
  revoked passport or capability, an out-of-scope capability, or an invalid
  authority chain -- those are all decided, by construction, before Approval
  Runtime is ever consulted.

Existing Recognition Runtime and Authority Graph tests are unaffected:
omitting the `approvalRuntime` argument reproduces prior behavior exactly.

## Demo scenario

PMFreak Closure Agent (an agent acting on Victor's behalf) requests
`send_client_follow_up` for `project:HMP-14665`:

1. Recognition Runtime's own `ApprovalPolicy` returns `require_human_approval`.
2. `recognitionRuntime.createApprovalRequestForDecision(...)` creates an
   `ApprovalRequest` in Approval Runtime.
3. Victor -- proven by Authority Graph to hold `approve_client_communication`
   over `project:HMP-14665` -- reviews the drafted email evidence and calls
   `approvalRuntime.approve(...)`.
4. Quorum (one approval) is satisfied; an `ApprovalProof` is created.
5. Recognition Runtime re-evaluates the same action; Approval Runtime reports
   `approval_valid`, and the decision becomes `allow`.

See `src/features/approval-runtime/tests/demo-scenarios.test.ts` for this
scenario plus its inverse cases: an unrecognized approver, an out-of-scope
approver, self-approval, expiry before approval, a two-approver quorum
(Project Manager + Finance Approver), and a revoked proof no longer being
usable for recognition.

## Determinism

Like Recognition Runtime and Authority Graph, Approval Runtime takes an
injected `ApprovalRuntimeContext` (`clock` + `ids`) rather than reading
`Date.now()` or generating random IDs:

- `createManualApprovalClock` / `ManualApprovalRuntimeClock` give tests
  `.set()` and `.advance()` for deterministic expiry testing.
- `createSequentialApprovalIdGenerator` produces predictable,
  human-readable IDs (`approval-request-000001`, ...).
- All hashing (`ApprovalProof.proofHash`, `ApprovalEvent.eventHash`) uses the
  same recursive-key-sort-then-SHA-256 approach as the other two runtimes:
  identical inputs always produce identical hashes, and no field of the
  computation depends on object key insertion order, wall-clock time, or
  randomness.
- No LLM, model call, or heuristic ever decides whether an approval is
  valid -- every policy in `policies/` is a pure function of its typed
  context.

## On the governed-action path (CORE-05)

The canonical governed-action path reuses this runtime's **semantics** — its
domain shapes and its policies — and not its in-memory services:

- `createAdmissionApprovalPolicyChain()` and `QuorumPolicy` judge every
  approval, rejection, request for changes and escalation, verbatim, over an
  `ApprovalRequest` built from the request's snapshotted requirement;
- approver standing comes through `createActorRegistryRecognitionIntegration`
  and `createApprovalAuthorityGraphIntegration`, pointed at the durable
  Kernel-Authority world (the one governed-path authority source);
- the authoritative record is `src/enterprise/approval-authority`'s
  append-only, **signed** approval log. `ApprovalStore`, `ApprovalProofService`
  (whose `proofHash` is an unkeyed integrity digest, not authenticity),
  `ApprovalLedger`, the sequential id generator and the
  `createApprovalRequestForDecision` one-approver fallback are **not** used
  there: they are in-memory and rebuilt with every Kernel-Authority world.

Library and legacy consumers (Recognition Runtime's `approvalProofId`
verification, `/api/governance/evaluate`, the control-plane panels) keep using
this runtime unchanged. See
`docs/architecture/ADR-DURABLE-APPROVALS-ON-THE-GOVERNED-PATH.md`.
