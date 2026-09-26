# ADR: Right-scoped governed authority and its transitions

- Status: accepted
- Related: `docs/architecture/ADR-TRANSFER-ACTION.md`,
  `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`,
  `docs/architecture/ADR-LICENSE-ACTION.md`,
  `docs/architecture/ADR-COLLATERALIZE-ACTION.md`,
  `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`
- Scope: `@aoc-enterprise/governed-authority`,
  `src/enterprise/authority-governance/`, `src/kernel/`,
  the four `src/enterprise/*-governance/` services
- Not a fifth governed action. Not an ownership registry. No Protocol change.

## Context: the gap `TRANSFER` proved

Implementing `TRANSFER` produced two measurements, recorded in
`src/enterprise/__tests__/transfer-authority-transition.test.ts` and in
`ADR-TRANSFER-ACTION.md`. Neither was designed into existence; both were run
against the real runtimes and could have gone either way.

**1. A completed transfer changed nothing about future enforcement.** After a
fully-evidenced movement of 25% of an economic interest from Party A to Party
B, Party B was authorized to do nothing with it, and Party A had lost nothing.
A second mandate for the same 25% was `allowed`. Only a per-mandate cumulative
rule stopped the same portion moving twice under the *same* mandate, and that
rule is scoped to one mandate.

**2. The Authority Graph could not express authority over a right.**
`AuthorityGrant` carries `capability`, `actions[]` and `resourceScopes[]`, and
no governed-right field of any kind — nor does `DelegationGrant`,
`RoleAssignment`, `RecognitionCapabilityToken` or any authority policy. Right
scoping was achievable only as an untyped string convention over
`resourceScope`, and the convention was **unenforced**: an actor scoped to
`asset:work-a:usage-right` could transfer the asset's *ownership interest*
while naming its own scope, because nothing connected the scope string to the
right the action was actually moving.

Together these say Soberanía could answer "is Actor A authorized to perform Action X
on Resource R?" and could not answer "which governed right does Actor A
control, how much of it, how did that arise, and how does completed execution
change it?"

## Decision

Introduce the minimum generic foundation for **right-scoped governed
authority** and **governed authority transitions**, consumed by the existing
`AocKernel` and by all four governed actions.

```
@aoc-enterprise/governed-authority     pure data: position, basis,
                                       transition, query/coverage
src/enterprise/authority-governance/   store (memory + SQLite) + resolver
src/kernel/                            one optional provider port,
                                       one typed declaration on ActionDescriptor
```

## What a position asserts, and what it does not

> **ASSERTS:** According to the governance state and evidence this Soberanía
> Enterprise deployment recognizes, Actor A has authority to exercise Scope S
> of Right R over Resource X, within a stated effective window.

> **DOES NOT ASSERT:** legal title, statutory ownership, beneficial interest,
> registry truth, or recognition by any authority outside this deployment.

There is deliberately no `OwnershipLedger`, `OwnershipRecord`, `LegalOwner` or
`TitleRegistry`. The bounded proposition is strong enough for Soberanía's own
subsequent enforcement and weak enough to be true. A deployment whose evidence
is wrong holds a position that is wrong in exactly the way its
`AuthorityGrant`s already could be — this changes the *subject* of the claim,
not its epistemic status.

## Authority basis vs action target

The two questions `TRANSFER` showed were being conflated are now separately
representable and separately checked.

| Question | Answered by | Example |
| --- | --- | --- |
| Why may this actor act at all? | Recognition Runtime + Authority Graph, unchanged | the portfolio manager holds a delegated `transfer` grant over `asset:governed-asset-a` |
| What right is this action engaging, and does its holder control it? | `action.governedRights` + the governed-authority resolver | 2 500 bp of `economic-interest`, held by Party A |

`ActionDescriptor.governedAuthorityHolderRef` is what keeps them apart. It
defaults to the requesting actor, and `TRANSFER` sets it to
`terms.transferorRef` with **no override**, because the rights leave the
transferor and pointing the check at anyone else would verify one party's
authority while depleting another's. A delegated administrator never acquires
the holder's underlying right by acting for it; the delegation machinery is
untouched.

Note what this does *not* newly permit: naming another party as transferor was
already possible before this foundation, and was already constrained only by
the requester's own resource-scoped Authority Graph grant. This layer adds a
constraint (the named transferor must actually hold what is moving) and removes
none. See "Known limitations".

## Position model

Identified by `(tenantId, actorRef, resourceKind, resourceId, governedRight)`.
Carries the current `scope`, an `effectiveFrom`, an optional `expiresAt`, and a
`lastTransitionRef` into its provenance.

**One position, not lots.** A credit into a right an actor already holds
*merges* using the canonical `governedRightsScopeSum`: 1 000 bp plus 2 500 bp
is one position of 3 500 bp. "How much does Alice control" must have exactly
one answer, and provenance is not lost by merging because it lives in the
append-only transition history. Lots were considered and rejected: they would
have made every read a fold, every debit a selection policy, and the
enforcement question ambiguous, in exchange for a provenance the transition log
already carries exactly.

**No stored status.** `pending`, `active`, `exhausted` and `expired` are a
total function of the scope, the window and the instant
(`governedAuthorityPositionState`). A stored status would be a second source of
truth that could disagree with the scope it describes.

**No restrictions on positions.** An action-specific constraint — "Bob may not
sublicence" — stays with the mandate that imposed it. Only something that binds
*future authority* would belong on a position, and `TRANSFER` produces nothing
of that kind today.

**Scope reuses `GovernedRightsScope` verbatim.** No second proportional or
unitized type was invented. Every comparison and every addition goes through
`governedRightsScopeWithin` and `governedRightsScopeSum`, which already encode
the kind-refusal and denomination-refusal semantics four actions agreed on.

## Transition model

Append-only. One transition per right moved, carrying the resource, right,
quantity, source (absent for issuance), target, basis, `occurredAt`,
`recordedAt`, a per-tenant `sequence`, and a digest chained to its predecessor.

**Generic, not transfer-shaped.** Nothing in the record names `TRANSFER`;
`basis.capability` carries whichever governed action produced the evidence.
There is no `TransferAuthorityMutationService`, no plugin registry and no
per-action dispatch — a future authority-changing governed action records the
same primitive, and one that does not simply never calls it.

**Three bases, closed union.** `administrative-bootstrap` and
`recognized-external-evidence` issue (credit without debit, privileged);
`governed-execution` conserves (debit and credit, evidenced). There is no
`self-asserted` variant and there must never be.

## When a transition happens

> **Accepted external execution evidence**, committed by the action's own
> store — and nothing earlier or later.

- **Not mandate issuance.** A `TransferMandate` is permission to move a right.
  Permission that is never exercised must move nothing, and treating issuance
  as movement would credit a recipient for a transfer that never happened.
- **Not lifecycle evidence.** A reported `registered`, `reversed` or
  `corrected` is an observation. An observation must not silently rewrite
  authority — see "Reversal" below.
- **Not the mandate's authorized terms.** The transition is built from what the
  evidence says *moved*, not from what was permitted to move: a mandate
  authorizing 2 500 bp under which 1 000 bp was reported moves 1 000 bp.

## Conservation, negativity and coercion

For a `governed-execution` basis the debit and the credit are the same quantity
and happen in one commit section, so the recognized total for a right is
invariant. Issuance is the only operation that changes a total, and it is
privileged.

`position scope >= 0` is enforced three times over: refused in the shared
lifecycle rules, refused inside each store's transaction, and made
unrepresentable by a `CHECK` constraint in the SQLite schema — so it holds even
against a writer bypassing the runtime entirely.

Proportional is never coerced to unitized, and no unit denomination is ever
converted to another. Both are refused as `GOVERNED_AUTHORITY_SCOPE_INCOMPATIBLE`.

## Reservation decision

> **SUPERSEDED by `ADR-GOVERNED-AUTHORITY-RESERVATION.md`.** The decision below
> is preserved as written, because the risk it quantified is exactly what the
> later ADR measured and closed. Reservation now exists, applies to `TRANSFER`
> only, and is acquired atomically before mandate issuance.

> **DEFERRED — EXECUTION-TIME CONSERVATION ONLY.** *(at the time of this ADR)*

Authorization reserves nothing. Two mandates may each be authorized for 6 000
bp against the same 10 000 bp position; only the second *execution* is refused.

This was chosen, not defaulted to, for three reasons drawn from the four
actions rather than from convenience:

1. **The four actions do not share reservation semantics.** The extraction
   audit already established that they disagree about whether a scope is even
   required and whether it accumulates: `TOKENIZE` bounds an issuance ceiling,
   `COLLATERALIZE` accumulates against an encumbrance, `LICENSE` frequently has
   no fraction at all, `TRANSFER` consumes. A generic reservation would have to
   mean the same thing for all four, and there is no such meaning.
2. **A reservation is not authority, and the distinction is easy to lose.**
   Reserved capacity, available capacity, controlled authority and executed
   transition are four different quantities. Introducing the first two before
   any action's domain demands them invites exactly the conflation
   §"Authority is not action-specific capacity" below warns about.
3. **Reservation needs a lifecycle nothing yet drives.** Release on revocation,
   release on expiry, proportional consumption on partial execution — each is a
   real rule with real replay-safety requirements, and building them ahead of a
   consumer would be building a framework.

**Residual risk, quantified.** Between mandate issuance and execution, a holder
may have mandates outstanding whose authorized scopes sum to more than it
controls. The exposure is bounded: no *movement* can overdraw, the total is
conserved regardless, and the window closes as soon as the first movement
completes — a mandate requested after it already sees the reduced holdings.
What can happen is an authorized mandate that later cannot be executed,
surfaced as `GOVERNED_AUTHORITY_INSUFFICIENT_SCOPE` at execution rather than as
a denial at request time. Measured in
`governed-authority-transfer-integration.test.ts`, "over-authorization".

A deployment that cannot tolerate that window needs reservation, and the
foundation does not prevent adding it: a reservation is a further quantity on
the same position, keyed by mandate, with its own lifecycle.

*That is what was built.* `GovernedAuthorityReservation` lives in this store
beside the positions, is keyed by the mandate it stands for, and carries the
lifecycle described in `ADR-GOVERNED-AUTHORITY-RESERVATION.md`. The measurement
in `governed-authority-transfer-integration.test.ts` now asserts the closed
behaviour: the second mandate is refused at issuance rather than at execution.
Three of this section's premises survived unchanged — the four actions still do
not share reservation semantics (only `TRANSFER` reserves), the four quantities
are still kept apart, and no lifecycle was invented beyond what `TRANSFER`
drives.

## Legacy authority compatibility

`AuthorityGrant` has never carried a governed-right field, so **every grant in
every existing deployment is legacy asset-scoped**. Three classes exist under
the new model:

| Class | What it is | What it authorizes |
| --- | --- | --- |
| legacy asset-scoped | an `AuthorityGrant` with `resourceScopes: ['asset:X']`, no positions recorded for `asset:X` | every right of `asset:X`, exactly as before — the resource is **not enrolled** |
| typed right-scoped | any resource with at least one recorded position | only rights the named holder actually holds a position in |
| typed right-and-scope-scoped | as above, where the action also names a quantity | only up to the quantity held |

The policy is **per-resource opt-in enrolment, one-way, failing closed**:

- A resource nothing has been recorded against is not enrolled. Behaviour is
  byte-for-byte what it was before this foundation existed, which is what every
  deployment needs on the day it ships.
- The moment a resource has **any** position, **every** governed right of that
  resource is enforced strictly — including rights nobody was bootstrapped
  into. Partial enrolment therefore fails closed: enrolling the usage right of
  an asset means a request against that asset's ownership interest is denied,
  not deferred.

So: **can a legacy grant authorize `TRANSFER` of an ownership interest?** Yes,
while the resource is unenrolled; no, once it is enrolled and the named holder
has no ownership-interest position. **`LICENSE` of a usage right?** Identically.
**What narrows it?** Recording a position — through the privileged bootstrap or
an evidence-based issuance — which is a deliberate administrative act.

The dangerous interpretation ("a legacy grant over an asset means authority
over every right of it, forever") is avoided because enrolment is one-way and
per-resource. The over-strict interpretation ("legacy authority authorizes
nothing") is avoided because unenrolled resources defer. A deployment that has
finished migrating sets `unenrolledResourcePolicy: 'deny'` and makes unenrolled
resources unreachable.

## Authority Graph integration

`AuthorityGrant` is **not modified**, and no existing authority consumer
changed. The Authority Graph continues to answer, unchanged, whether an actor
may perform an action on a resource scope.

```
Governed Authority State (positions + transitions)
        |
        v
Governed Authority Resolver            one question, one coverage verdict
        |
        v
AocKernel  <-- Recognition Runtime <-- Authority Graph   (both unchanged)
        |
        v
Governed Action evaluation
```

The Kernel gains one optional provider port and runs the check **after** the
wrapped engine's chain, against an outcome that chain already found viable
(`allowed` or `approval_required`), and it can only narrow that outcome into a
denial. This is exactly the discipline Recognition Runtime already applies when
it consults the Authority Graph. Consequences worth stating:

- A rogue, unrecognized, revoked or out-of-scope actor is stopped by the
  existing chain before governed authority is ever consulted. This layer cannot
  rescue a denial.
- No request succeeds that would have failed without this layer.
- `AocKernel` remains the only component that produces a decision. No
  `RightsKernel`, `OwnershipKernel`, `TransferKernel` or `PositionKernel`
  exists, and the resolver decides nothing about actors, capabilities,
  delegation, approvals, policy or evidence.

`enforce()` resolves coverage *before* the executor runs rather than folding it
in afterwards — a side effect that has already happened cannot be denied — and
deliberately does not re-run `evaluate()` to do so, which would consume the
request's idempotency key and make the real enforcement come back
`duplicate_suppressed`.

## Cross-action integration

All four actions declare their target rights as typed vocabulary on
`ActionDescriptor` instead of leaving them inside `parameters` where no
authority check could reach them. Domain semantics are unchanged in all four.

| Action | Rights | Scope forwarded | Holder |
| --- | --- | --- | --- |
| `TOKENIZE` | `terms.rights` | `terms.scope` (required, an issuance ceiling) | `authorityHolderRef` ?? requester |
| `COLLATERALIZE` | `terms.rights` | `terms.scope` (required) | `authorityHolderRef` ?? requester |
| `LICENSE` | `terms.rights` | `terms.rightsScope` **only when present** | `authorityHolderRef` ?? requester |
| `TRANSFER` | `terms.rights` | `terms.scope` (required, conserved) | `terms.transferorRef`, not overridable |

`LICENSE`'s absent rights scope is preserved rather than defaulted, and this is
the case the whole "absence is not 100%" rule exists for. An absent scope means
the holder must hold *some* live authority over the right and asserts nothing
about how much: a 1 bp position covers an unquantified permission exactly as a
10 000 bp one does, because the permission is not a quantity of the right.
Substituting a full scope would silently require whole-right authority for every
unquantified licence; substituting zero would require none. The licence's
*permission* scope — `permittedUses`, exclusivity, term — is a different
quantity and is never forwarded here.

An action naming several rights needs authority over **all** of them. Partial
coverage is not coverage.

## Authority is not action-specific capacity

A committed collateralization does **not** reduce the underlying authority
position. Whether encumbering 2 500 bp should reduce transferable capacity to
7 500 bp depends on encumbrance semantics and deployment policy, and this
foundation deliberately does not answer it. What it separates is:

```
controlled authority        the position          this foundation
committed/encumbered        the mandate           each action, already
executed transition         the history           this foundation
reserved                    -                     deferred
```

## Durability, concurrency and integrity

In-memory and SQLite implementations behind one behavioural contract, run
twice by the same suite. SQLite follows the established conventions:
`better-sqlite3`, `foreign_keys=ON`, `WAL`, `synchronous=FULL`,
`busy_timeout`, a schema-version guard that refuses a mismatched database
before any DDL runs, and one synchronous `db.transaction(...)` per mutating
call.

Conservation is a concurrency problem before it is anything else. Every check
and every write happen inside one transaction, so the lost update that would
let one 10 000 bp position fund two 6 000 bp movements cannot occur — the
second transaction reads the already-debited balance and its debit is refused.
The in-memory store holds the same property by never awaiting inside a
critical section. Cross-process writers are serialized by the `UNIQUE`
constraints, which also make a double-applied execution unrepresentable rather
than merely refused.

Integrity reuses the Governance Store's canonical digest primitive
(`computeDigest`, sha256 over canonical JSON). Positions carry a store-computed
digest recomputed on every read; transitions carry a digest chained to their
predecessor, so a removed or reordered transition is detectable even when every
remaining row verifies individually. Governance *Reference* Integrity was
deliberately **not** reused: it chains references belonging to one governance
evaluation, and an authority transition belongs to a tenant's history rather
than to any single evaluation. Reusing it would have meant inventing an
evaluation to hang transitions from.

The limits are the Governance Store's own, unchanged: this is tamper
*evidence*, not a signature, and not proof against a privileged writer who
rewrites a record and its digest together.

## Atomicity across two stores

Transfer execution evidence and governed authority live in independent durable
stores that cannot share a transaction. The ordering is chosen for its failure
mode: **evidence commits first**, so a crash in the window leaves authority
*under*-credited — never credited without evidence behind it — and the missing
transition is recoverable from the evidence that survived.

`TransferGovernanceService.reconcileAuthorityTransitions(mandateId)` is the
deterministic recovery path. It is idempotent, safe to run at any time, and a
no-op once every execution has moved authority. A transition that fails
propagates rather than being swallowed, so a caller learns that the movement
was recorded and its authority consequence was not — and reconciliation of an
unconservable movement fails the same way rather than inventing authority to
make the books balance.

## Bootstrap and no self-issued authority

Authority enters a deployment only through `bootstrapPosition`, which requires
`context.system` and an issuing basis. It is a store operation reachable from
no governed action, no request handler and no HTTP route. There is no public
API by which a party could obtain a position by claiming one, and the basis
union is closed so that none can be added by accident.

Protocolization, asset registration, legal-title proof and notarization are
explicitly out of scope. They may later become sources of positions; they are
not implemented here.

## Reversal

Not implemented, and the omission is the decision. Lifecycle evidence reporting
a movement as `reversed` or `corrected` does **not** produce an inverse
transition. Reversing recognized authority is a governance act requiring its
own authority basis, and inferring it from an observation would let an external
system rewrite Soberanía's authority state by reporting. Deferred with the semantics
stated rather than left ambiguous.

Likewise there is no authority-revocation API: withdrawing an actor's
underlying authority is a different event from revoking a mandate, needs its
own basis, and has no existing Authority Graph counterpart to mirror.

## Protocol boundary

> **NO PROTOCOL CHANGE. Enterprise foundation sufficient; portability
> deferred.**

Re-evaluating the question `ADR-TRANSFER-ACTION.md` left open, now that the
foundation exists:

- **Can Enterprise represent and enforce right-scoped authority transitions
  fully locally?** Yes. Positions, transitions, conservation, the resolver, the
  Kernel port and all four action integrations are Enterprise-local. `@aoc/protocol`
  was consumed unchanged and its lock, consumption and contract-adoption checks
  pass untouched.
- **Does Protocol hold anything a transition would update?** No. Its contract
  surface is identity, delegation, constraint, proof, capability, consent,
  scoped access, audit and trust-domain vocabulary; `ResourceRef` is
  `{kind, id, tenantId?, attributes?}` — pure identity. There is no owner,
  holder, controller or sovereign-ownership record for a completed transfer to
  change.
- **Does another independently governed deployment need to trust or consume
  this authority state?** Not demonstrated. Every consumer today is inside one
  Enterprise installation.

A Protocol primitive would become justified if — and only if — an authority
position had to cross Enterprise boundaries, two independent deployments needed
common sovereign state, portable proof of an authority transition were
required, or a resource's sovereignty anchor had to change independently of any
one installation. Reported as future thresholds; nothing speculative is
implemented.

Re-evaluated when holder-bound representative authority was added, and the
answer did not change: representation is likewise Enterprise-local governance
configuration with no Protocol counterpart, and it adds one further threshold to
the list above — a representation having to be portable across independent
sovereign deployments, so that one could prove to another that a representative
legitimately represents a holder. Also not reached. See
`ADR-HOLDER-BOUND-REPRESENTATIVE-AUTHORITY.md`, "Protocol boundary".

## Alternatives rejected

- **Extend `AuthorityGrant` with a governed-right field.** Rejected: it would
  change a frozen contract every authority consumer reads, conflate "may call
  this action" with "controls this right", and still leave the grant carrying no
  quantity, no conservation and no history.
- **A transfer-specific balance update inside `TRANSFER`.** Rejected as an
  action-local invention presenting itself as an architectural guarantee — the
  same reason the original `TRANSFER` implementation refused to simulate a
  right-scoped check.
- **Hierarchical scope strings (`asset:X:right:usage-right:2500`).** Rejected
  as the *semantic* mechanism; that is precisely the unenforced convention the
  finding identified. String scopes remain as routing and compatibility
  primitives and are unchanged.
- **Folding authority state into `@aoc-enterprise/governed-authorization`.**
  Rejected on package responsibility: that package is deliberately about things
  that never change after they are written, and every action contract depends on
  it.
- **Full event sourcing** (positions derived per read). Rejected: the
  enforcement path answers a coverage question on every governed request, and
  replaying history per request is a different system. Transitions are the audit
  chain; positions are the index.

## Known limitations

- A delegated administrator authorized over a resource may name any holder as
  the party whose authority is drawn on. This layer constrains *what* may be
  acted upon, not *who* may act — that remains the Authority Graph's question,
  and a deployment narrows it with resource-scoped grants. Not newly introduced
  by this change.

  > **Since closed.** This limitation was measured and found to be exactly as
  > stated, then addressed by a separate layer rather than by any change to the
  > model above. `GovernedRepresentativeAuthority` binds a requester to the
  > specific holders whose authority it may exercise, and is required on every
  > enrolled resource whenever the requester and the holder differ. The
  > positions, transitions, conservation rules and coverage semantics recorded
  > in this ADR are unchanged. See
  > `ADR-HOLDER-BOUND-REPRESENTATIVE-AUTHORITY.md`.
- Bootstrapping onto an existing position adds to its scope and does not rewrite
  its effective window; a deployment needing authority with a different window
  records it as a different position, which the current key does not permit for
  the same actor, right and resource. Positions with heterogeneous windows for
  one holder would need lots.
- Enrolment is inferred from the presence of any position for a resource. A
  resource whose positions have all been fully transferred away remains
  enrolled, which is the intended direction (fail closed) but is worth stating.
- Cross-store atomicity is bounded by recovery rather than by a transaction.
- Nothing here makes any claim outside this deployment.

## Consequences

Frontera Systems no longer merely governs isolated actions. It maintains governed
continuity of authority across them:

```
Authority -> Action -> Execution -> Authority Transition -> New Authority -> Next Action
```

Alice controls 100% of a right; transfers 25% to Bob; the movement is
evidenced; after a restart Alice controls 75% and Bob controls 25%; Bob may
govern up to 25% and no more; Alice may govern up to 75% and no more; and
authority over another right does not substitute for authority over this one.
