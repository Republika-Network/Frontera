# ADR — Durable Approvals on the Governed Path (CORE-05)

- **Status:** Accepted (CORE-05, 2026-09-28)
- **Roadmap item:** CORE-05 — Durable Approvals (engine side), `docs/architecture/FRONTERA-MASTER-PLAN.md` §9
- **Builds on (unchanged in substance):** `src/features/approval-runtime` (its domain model and policies are the approval semantics), `ADR-TRUSTED-CONTEXT-AND-OBLIGATIONS-ON-THE-GOVERNED-PATH.md` (CORE-04: the trusted effective-profile rule, the resumable-decision pattern, the signed-state-commitment pattern), `AUTHORITY_ARTIFACT_AUTHENTICITY.md` (CORE-01 / PRE-00: signer, verifier, key rotation)
- **Non-goals kept:** UI, inbox and notification (CTRL-04); human identity, roles and provisioning (CTRL-02); any AI (INTEL)

## 1. Context

Before CORE-05:

| Capability | Before CORE-05 |
|---|---|
| `approval_required` on the governed path | **Terminal.** `orchestrator.ts` ended every such decision `withheld: 'approval'`; a retry replayed the committed decision and was withheld again, forever |
| approval-runtime | Sound domain semantics (requirement, request, decision, proof, quorum, segregation of duties, evidence, expiry, revocation, escalation) — but **in memory**, synchronous, sequential ids from an injected counter, an unkeyed `proofHash` (SHA-256 integrity, not authenticity), a mutable status field, and a permissive fallback (`createDefaultRequirement`: one approver) for a decision with no registered requirement |
| approval-runtime on the Kernel path | Hydrated fresh into every Kernel-Authority world (`hydration.ts`) and rebuilt on every Kernel-Authority change: always empty on the governed path. The governed-action envelope never forwarded `approvalProofId`; `/api/governance/evaluate` does, but only evaluates |
| Approver authority | approval-runtime asks an Authority-Graph-shaped port; on the Kernel path that port *is* the hydrated Kernel-Authority projection |

## 2. Decision

### 2.1 Reuse the semantics, add durable authenticated facts

approval-runtime is **not** replaced and **not** forked. Its in-memory
`ApprovalStore`, `ApprovalProofService` and `ApprovalLedger` are not used on the
governed path (they are neither durable nor authenticated, and the runtime is
rebuilt on every Kernel-Authority reload); its **domain model and policies are
the approval semantics**, run verbatim:

- `createAdmissionApprovalPolicyChain()` — valid request, recognized approver,
  approver authority, scope, evidence, segregation of duties, expiration,
  revocation, duplicate — judges every attempt, at submission **and** again on
  every read;
- `QuorumPolicy` decides completion;
- `ApprovalRequest` / `ApprovalRequirement` / `ApprovalDecision` /
  `ApprovalEvidenceArtifact` are the shapes those policies judge, built from
  the request's requirement **snapshot**;
- approver standing comes through approval-runtime's own
  `createActorRegistryRecognitionIntegration` and
  `createApprovalAuthorityGraphIntegration`, pointed at the composed
  Kernel-Authority world.

What CORE-05 adds (`src/enterprise/approval-authority`) is the one thing the
runtime lacks: an **append-only, authenticated log of facts** and a
deterministic replay of those facts through the runtime's policies.

### 2.2 What is authoritative, what is derived

| Thing | Status |
|---|---|
| Approval log rows (`requested`, `approved`, `rejected`, `requested_changes`, `escalated`, `revoked`) + the signed head | **Authoritative.** The only durable approval state |
| Request state (`pending` / `approved` / `rejected` / `revoked` / `request-expired` / `approval-expired`), counted approvers, quorum | **Derived** on every read by replay; never stored, never writable |
| Approval proof (`approvalDigest`) | **Derived identity** of a completed approval: a digest over the exact target (subject digest, which binds the decision and the requirement snapshot), the counted verdict row digests (and so their evidence hashes), quorum, `approvedAt`, `notAfter`. Not a stored artifact, not a bearer credential. It becomes authority only inside a grant's signed `sourceDigest` |
| approval-runtime `ApprovalLedger` | Not used on the governed path. The authenticated log is the audit trail (ASSURE may project it) |

### 2.3 Lifecycle

```
GovernedAction → trusted semantics / context / policy → Kernel
  → committed decision: approval_required  (Governance Store, re-read, verified)
  → orchestrator approval phase: assess(request, decision, evaluationId, record digests)
      ├─ decision does not await a human approval (Kernel's decisionAwaitsHumanApproval) → not-applicable → withheld as before
      ├─ trusted effective profile (CORE-04 selectEffectiveProfile) has no approval requirement → not-applicable → withheld
      └─ else: open the ONE canonical request (first time: `requested` row with the canonical subject)
  → authenticated actor context → approve / reject / requestChanges / escalate / revoke
      (approval-runtime admission chain, Kernel-Authority standing now)
  → retry (same idempotency key → same committed decision)
      → replay → state `approved`, not lapsed → { approvalDigest, notAfter }
      → emergency control → grant terms (≤ context validUntil, ≤ notAfter)
      → obligations re-read (independent gate)
      → issuance: Kernel `withVerifiedHumanApproval(source, decision, approvalDigest)`
          + `decision` validity ceiling at notAfter
      → exercise pre-assessment → approval re-assessed (same digest required) → claim → adapter
```

The committed decision is **never re-made and never rewritten**: its status
stays `approval_required` in the Governance Store. The only change is in the
grant source the Kernel adapter derives: `authorizationPermitsExercise` becomes
`true` together with `approvalDigest` — and only for a decision that is
`approval_required` with an approval reason code (never evidence, handshake,
denial, indeterminate or allowed).

### 2.4 Exact target — the approval subject

`frontera.approval-subject.v1`, canonical JSON (approval-runtime's
`stableStringify`), computed by trusted code from the committed, re-read and
verified decision and from trusted configuration only:

organization, requestId, decisionId, evaluationId, **the Governance Store's own
digests of the committed record** (`requestDigest`, `evaluationDigest` — no
second canonicalization), actor and principal, action, resource, counterparty,
amount, **trusted** effective profile key and its classes, typed parameters,
admitted-context digest and validity, the Kernel's status, reason codes and
instant, and the **requirement snapshot** with its digest.

The approval request id is `approval-request:<sha256>` over
`(organization, requestId, decisionId, subjectDigest)` — deterministic from
immutable identity, never a counter. One committed decision has exactly one
canonical request; retries and concurrent assessments find it (serialized
in-process, single-writer SQLite). Anything else already opened under the same
`requestId` — another decision, or the same one under other bytes (changed
profile, requirement, parameters, context or record digests) — is a
substitution: `superseded`, never approved and never a second lifecycle.

### 2.5 Requirement — trusted, snapshotted, never synthesized

A Governance Profile may declare `approval { approverAction, minimumApprovals,
requestTtlSeconds, approvalValiditySeconds, requiredEvidence? }` (closed,
bounded; `approverAction` must not be a governed action — authority to approve
is not authority to act). It is selected **only** through the trusted CORE-04
effective-profile resolution (action × resource); the request's `semantics`
claim may only agree (bogus, other-version and other-configured claims select
nothing). No requirement → no lifecycle → withheld: the runtime's
one-approver fallback is never reached on the governed path.

The requirement is snapshotted into the request. A configuration change never
reinterprets an open or completed request: if trusted configuration no longer
holds the exact profile and requirement the request was opened under, the
request is **superseded** (withheld; commands refused). A new governed request
starts a new lifecycle under the new configuration.

### 2.6 Approver identity and authority

The command port (`enterprise.approvals`: `pending`, `describe`, `approve`,
`reject`, `requestChanges`, `escalate`, `revoke`) takes an
`ApprovalCommandContext { authenticated: true, actorId, authenticatedBy }` —
constructed by trusted in-process code (CTRL-04 later, after authenticating a
human) — and a **closed** command `{ approvalRequestId, subjectDigest,
evidence?, reason? }`. A command naming an approver (or anything else) is
refused. The port exposes no store, no append, no state, no proof writer.

Standing is Kernel-Authority, the one governed-path authority root: the actor
must be recognized in the durable world, hold live authority for
`approverAction` over exactly the request's resource (approval-runtime's
`ApproverAuthorityPolicy` / `ApprovalScopePolicy`), and every hop of that
authority must be active and unexpired (the CORE-04 lineage revalidator).
Execution authority confers nothing: the owner who may *settle* may not
*approve* without separate approver authority.

**At submission and at use.** Standing is re-resolved when a verdict is
submitted and again on every read of the state. **Decision:** approval is live
lineage, not history — an approver whose authority is revoked or expires
withdraws their unused approval, so a proof whose supporting authority is gone
cannot mint a new grant. Restrictive verdicts (`rejected`, `revoked`) stay
final whatever later happens to their author's authority (un-counting them
would widen authority).

### 2.7 Segregation of duties, quorum, rejection, changes, escalation

- **SOD:** approval-runtime's `SegregationOfDutiesPolicy`, always required on
  the governed path: the requesting actor (also the target) cannot approve its
  own request; the principal it acts for is deliberately *not* barred — the
  human-owner review the policy exists to enable. The requester may reject
  (runtime semantics: restrictive).
- **Quorum:** distinct valid approvers only (`DuplicateApprovalPolicy`,
  `QuorumPolicy`), each verdict belonging to exactly one request — no pooling.
  Concurrent approvals are serialized: exactly one completion, one proof; a
  later approval on a completed request is refused.
- **Rejection:** final; a later approval is refused; the row is never deleted.
- **Requested changes / escalation:** recorded, change nothing (no quorum, no
  proof). A request needing changes is superseded only by a new governed
  request. Notification is CTRL-04.

### 2.8 Evidence

`requiredEvidence` names approval-runtime evidence types; an approving verdict
must cite each by `sha256:` hash (`ApprovalEvidencePolicy`). The reviewed
references are canonicalized into the verdict row, so they are inside the row
digest, the signed chain and the proof digest: changing reviewed evidence
cannot preserve a proof. CORE-05 does not verify the external artifacts
themselves (ASSURE).

### 2.9 Expiry and validity

- Request: accepts verdicts strictly before `evaluatedAt + requestTtlSeconds`
  (runtime `ExpirationPolicy`, judged at the verdict's recorded instant).
- Proof: usable strictly before `approvedAt + approvalValiditySeconds`.
- Decision/context validity dominates: the grant proposal is clamped to the
  earliest of the ordinary lifetime, the CORE-04 context `validUntil` and the
  approval's `notAfter`, and issuance carries `notAfter` as a `decision`
  validity ceiling. An approval can never extend any of them.

### 2.10 Revocation

`revoke` (live approval authority required; no SOD) closes a pending request
or a completed approval. After it, no grant is minted. **After issuance:** the
orchestrator re-assesses the approval immediately before the write-ahead claim
and requires the same `approvalDigest`; a revocation (or a withdrawn approver,
or a lapse) between issuance and exercise leaves the adapter uncalled. An
execution already claimed is history and is answered from the record.

### 2.11 Grant materiality

`approvalDigest` is part of the canonical grant-source bytes (additive; absent
→ byte-identical to every pre-CORE-05 source), so it is inside every resumed
grant's `sourceDigest`, identity, digest and Ed25519 signature. Removing or
swapping it changes the source.

### 2.12 Authenticated durable state (CORE-01 / CORE-04 pattern)

Own SQLite file (`AOC_ENTERPRISE_APPROVAL_SQLITE_PATH`), schema v1 (the first
durable format; no unauthenticated mode exists or is accepted):

- every row digest binds `(storeId, sequence, content)`; a hash chain from a
  genesis bound to a random store id and the organization; head
  `{storeId, organizationId, sequence, chainDigest}` signed by the existing
  authority signer under `frontera:authority-artifact:approval-state:v1`
  (`signApprovalState` / `verifyApprovalState`);
- every authoritative read (open, every command, every `assess`) verifies the
  signature and recomputes the exact set: count, contiguity, row digests,
  organization, closed kinds, chain;
- **verified-state-before-write:** verify → plan → sign → `BEGIN IMMEDIATE` →
  re-verify the whole history equals the planned base → insert row + update
  head in one transaction;
- genesis only for a file with no schema objects at all; content without
  identity, identity without head, unknown schema → refused;
- key rotation: a state verifying under a trusted previous key is re-attested
  **unchanged** under the active key inside a re-verifying transaction, then
  read back; tampered state is never re-attested;
- an in-process witness refuses regression while the process lives.

## 3. Threat review

| Threat | Classification |
|---|---|
| Caller-supplied proof / `approvalProofId` | Mitigated — closed intent schema; never forwarded; proof is derived server-side |
| Caller-supplied requirement / caller-selected profile | Mitigated — trusted resolver only; snapshot; bogus/other/weaker claims select nothing |
| Approver identity spoof | Mitigated — actor only from trusted context; closed command. Residual: in-process code can construct a context (SEC-TRUST-001, CTRL-04) |
| Unauthorized / out-of-scope / unrecognized approver | Mitigated — Kernel-Authority standing, at submission and at use |
| Self-approval | Mitigated — SOD (requester/target); owner review preserved |
| Duplicate quorum, pooling across requests | Mitigated |
| Decision / action / resource / parameter / profile / context / org substitution | Mitigated — subject digest + Governance Store digests; superseded |
| Evidence rewrite | Mitigated for references/hashes; external artifact truth → ASSURE |
| Expiry bypass, validity extension | Mitigated — injected clock; earliest ceiling |
| Requirement downgrade | Mitigated — snapshot + supersession |
| DB insertion / deletion / rewrite / reorder / duplicate / gap / transplant, hash recomputation, attacker-signed head | Mitigated — signed head + exact-set chain |
| Laundering through a legitimate later write | Mitigated — verified-state-before-write |
| Half-write / crash | Mitigated — one transaction; half state refused at open |
| Old-key state | Mitigated — CORE-01 re-attestation rule |
| Revocation between issuance and exercise | Mitigated — pre-claim re-assessment |
| Genuine-state rollback across restart | **Bounded residual → CORE-07.** Restoring an older genuine signed state (e.g. approved before a revocation) is believed after restart (pinned by test). Bounded by the approval's validity window and every other gate |
| Process / signing-key compromise | **Deferred → CORE-02** (`signApprovalState` joins the external signer's operation set) |
| Governance Store rewrite (integrity-only) | Bounded — a rewritten record changes its digests → the approval subject no longer matches → superseded |

## 4. Residuals and owners

Rollback across restart (CORE-07); key/process compromise (CORE-02); human
authentication, inbox, notification (CTRL-04); human identity administration
(CTRL-02); portable approval evidence (ASSURE-01..03); approval store backup
(PROD-02); one organization per Host; a dangling grant issued immediately
before a pre-claim refusal remains unexercised until its (approval-capped)
expiry.
