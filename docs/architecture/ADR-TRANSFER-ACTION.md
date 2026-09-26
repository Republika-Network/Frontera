# ADR: `TRANSFER` as the fourth governed enforcement

- Status: accepted. **Two findings below were subsequently resolved — see
  "Resolution status" at the end of each. The findings themselves are
  preserved verbatim: they were measurements of the architecture as it stood,
  and they remain accurate about it.**
- Related: `docs/architecture/ADR-GOVERNED-AUTHORITY-TRANSITION.md`,
  `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`,
  `docs/architecture/ADR-COLLATERALIZE-ACTION.md`,
  `docs/architecture/ADR-LICENSE-ACTION.md`,
  `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`
- Scope: `@aoc-enterprise/transfer-mandate`,
  `src/enterprise/transfer-governance/`

## Context

Frontera Systems governed three exercises of authority over a governed asset:
representing rights externally, encumbering them, and permitting their
exercise. All three leave the question "who holds this right?" untouched.

`TRANSFER` is the first that does not. It was implemented fourth deliberately:
it is the action most likely to force a Protocol question, most likely to
tempt an action-specific mutation of shared authority state, and — because it
supplies a fourth independent data point — the one that could settle the
generalization questions three enforcements had left open.

## Domain decision

> `TRANSFER` authorizes the movement of specified governed rights associated
> with an already-governed asset — or a defined portion of those rights — from
> a specified current holder to a specified recipient, under defined governance
> conditions.

Soberanía governs the authority to transfer. It does not transfer, does not update
any register, and does not learn that anything moved except by being told.

## The decisions that were not forced by symmetry

Each of the following was decided from the domain and is evidence for the
four-enforcement audit rather than a stylistic choice.

### The quantity is conserved, not merely bounded

`TOKENIZE`, `COLLATERALIZE` and `LICENSE` all bound a quantity. `TRANSFER`
moves one, and everything distinctive follows from that.

**`scope` is required** — the opposite of `LICENSE`. "Company B may display
this work for 12 months" is a completely specified permission with no fraction
anywhere in it, which is why `LICENSE` had to make its rights scope optional.
A transfer is not like that: moving a right is inherently a question of how
much of it moves, and there is no third option between "all of it" and "some
stated portion". `10000` basis points genuinely means "the whole", and stating
it is a claim the transferor makes rather than a coercion the contract imposed.

**Transferred scope accumulates**, matching collateral structurally and
exceeding it semantically. Collateral scope is summed because encumbering a
finite right twice exhausts it; transferred scope is summed because the right
*left*, and what has left cannot leave again.

**`partialTransferAllowed` decides both partiality and repetition.** For
`LICENSE` and `COLLATERALIZE` those are separate questions with separate flags.
For a conserved quantity they collapse into one, because permitting tranches
*is* permitting repeat execution. The consequence is an asymmetry worth
stating: when partiality is prohibited, a **smaller** movement is refused too.
A licence for at most ten seats is honoured by granting five; a transfer of
25% that moves 10% has not partially satisfied the authorization — it has
performed the partial transfer that was prohibited, leaving 15% in a state no
one authorized.

### `transferorRef` — the first source party any action has had

No sibling action names the party an authorization takes something *away*
from, because none of them takes anything away. `TRANSFER` has a source as well
as a destination, and the source is emphatically **not the requester**: a
delegated administrator, a corporate secretary or a managing agent routinely
submits a transfer of a right held by the entity it acts for.

Equating the two would silently convert "who asked" into "whose property this
was" — the most dangerous conflation this action could make. The request
records whose right is moving as a *claim*; the Kernel decides whether the
requester had the authority to move it. The evidence lineage surfaces
`requestedBy` and `transferorRef` side by side precisely so a reviewer can see
when they differ.

### `transfereeRef` is binding without exception

`EnterpriseLicenseTerms` has an assignment disposition that can relax the
licensee binding. `TRANSFER` deliberately introduces **no equivalent**, and
this is a domain finding rather than an omission.

A licence's assignment disposition governs what the licensee may later do with
a permission it already holds — a fact about the licensee's downstream conduct.
A transfer has no analogue: a "substituted recipient" is not a relaxation of
anything, it is a different transfer, to a different party, requiring its own
authority, policy and approvals. A flag that let a mandate name Company B and
be executed for Company C would create exactly the escalation this contract
exists to refuse.

Binding the transferee as the executor of its own acquisition is likewise
rejected at validation: it would make the executor binding vacuous.

### `executorRef` is optional — confirming `LICENSE`, for a sharper reason

`LICENSE` showed that *some actions* have no necessary external performer.
`TRANSFER` shows something narrower and stronger: the **same action** has one
in some arrangements and not in others. A holder moving a right directly
performs the act itself; a movement effected through a registry, a custodian or
a transfer agent has a distinct performer whose identity should be bound.
Requiring one would force every direct transfer to invent a party, and an
invented binding protects nothing.

This is the second independent falsification of "authorized executor is a
universal primitive".

### Recipient acceptance is a constraint, not a workflow

Considered as a status, as a mandatory approval, and as an evidence
requirement. Decided: **an evidence requirement, with the Approval Runtime
available for deployments that need it governed.**

Whether a transfer needs acceptance is entirely arrangement-specific — a
registered book-entry movement typically does not; a novated contractual claim
typically does. Hard-coding it universally would misrepresent the first case,
and omitting it entirely would misrepresent the second. So
`recipientAcceptanceRequired` records the requirement and it is *checked* at
execution against a reported acceptance reference, exactly as
`externalAgreementReferenceRequired` works for licences. A deployment that
wants acceptance to be a governed prerequisite rather than an evidenced fact
expresses it through the Approval Runtime, which already models exactly that.
Soberanía runs no acceptance workflow.

### Consideration is a reference, never an amount

Transfers frequently have a price, and this is the point at which it would be
easy to start modelling one. Soberanía does not. `considerationEvidenceRequired`
requires that a *reference* be reported; the reference is opaque; **there is no
amount field anywhere in this action**, `amount`/`currency` are deliberately
not populated on the Kernel request, and no arithmetic is performed on
consideration anywhere. Soberanía computes no price, holds no funds, escrows nothing
and settles nothing.

### Lifecycle evidence is observation, and restores nothing

`registered · rejected · reversed · corrected · superseded`, recorded
append-only against a specific movement, never as a mandate status.

The strictest rule this action has: **a reported reversal does not decrement
the transferred scope or the execution count.** Soberanía cannot verify that an
external movement was undone, and decrementing would manufacture fresh transfer
capacity over a right already recorded as having left. The temptation to break
this rule is greater here than for any sibling, and it is refused in both store
providers and asserted in both the in-memory and durability suites.

`REVERSE_TRANSFER`, `RESCIND_TRANSFER` and `RETURN` are recorded as *different*
actions and none is implemented. Were reversal ever to need *authorizing*
rather than *observing*, it would be a transfer in its own right — rights
moving back — not an undo button on this one.

`'completed'` and `'settled'` are deliberately absent from the lifecycle
vocabulary. The execution evidence *is* the report that the movement happened;
a second "it really happened" category would invite a caller to treat the first
record as provisional, which it is not.

## Post-transfer authority

**This is the primary finding of the whole implementation, and it was measured
rather than designed.** See
`src/enterprise/__tests__/transfer-authority-transition.test.ts`.

After a mandate is issued, a movement effected, execution evidence recorded and
a registration reported — the complete lineage, integrity-sealed, surviving
restart:

- **The recipient acquires nothing.** A governed request submitted by Party B
  over the right it just received is **denied**. Party B is not an actor the
  Authority Graph knows, because recording transfer evidence does not create
  authority.
- **The transferor loses nothing.** Its authority over the asset is unchanged,
  so a second `TRANSFER` request for the same 25% is still `allowed` at the
  governance layer. Only the per-mandate conservation rule stops the same
  portion moving twice, and that rule is scoped to one mandate: **nothing in
  Soberanía knows that Party A now holds 25% less.**
- **No surface exposes a current holder**, and the evidence lineage
  deliberately declines to derive one. Soberanía never verified the movement and
  holds no ownership state to update.

The only thing that changes any of this is an explicit administrative act —
registering the actor, issuing a passport, a capability token and an authority
grant. The control test in the same suite performs exactly that and the onward
request is then `allowed`. **No transfer code path performs any of it.**

### Why this was not "fixed"

Three options were considered.

**A. Enterprise records only execution evidence.** — *chosen.*
**B. Enterprise maintains a derived current-holder state.** — rejected.
**C. A Protocol-level transition.** — rejected as not yet required.

Option B fails on the same principle the whole action is built on: Soberanía never
verified that the movement happened. A derived holder state would present an
unverified external report as a governance fact, and every subsequent
authorization would silently rest on it. It is the highest-consequence version
of exactly the mistake `'completed'`-as-a-status and reversal-restores-capacity
would have been.

There is also no generic mechanism to hook into. The Authority Graph is
mutated only by explicit administrative acts (`issueAuthorityGrant`,
`createDelegationGrant`), and there is **no authority-transition primitive** —
nothing that says "authority over X moved from A to B" as a first-class,
evidenced, revocable operation. Adding a bespoke Transfer-specific write into
the Authority Graph would be solving a foundational ownership-transition
problem with an action-specific hack, which this task explicitly forbids and
which would be wrong regardless.

**Finding: AUTHORITY-TRANSITION GAP IDENTIFIED.** Enterprise can represent that
a transfer was authorized and reported executed. It cannot represent that
authority moved, because no primitive for that exists at any layer. This is
recorded as a genuine architectural gap and deliberately left open.

### Resolution status: RESOLVED

The gap was closed by a subsequent, generic foundation — not by a change to
this action's semantics. See
`docs/architecture/ADR-GOVERNED-AUTHORITY-TRANSITION.md` and
`docs/enterprise/AOC_GOVERNED_AUTHORITY.md`.

What changed, precisely:

- **The primitive now exists.** `GovernedAuthorityTransition`
  (`@aoc-enterprise/governed-authority`) says "a quantity of right R moved from
  A to B, on this evidence, at this instant", as a first-class, append-only,
  conserved, replay-safe operation. It names no action; `TRANSFER` is its first
  consumer and `basis.capability` carries whichever action produced the
  evidence.
- **The recipient now acquires authority**, and the transferor loses the
  corresponding scope, on accepted execution evidence. `Alice 10 000 / Bob 0`
  becomes `Alice 7 500 / Bob 2 500`, survives restart, and is enforced by the
  same resolver all four governed actions consult.
- **A second mandate for the same 25% is now denied** once the first has been
  executed, with `AUTHORITY_GOVERNED_SCOPE_EXCEEDED`. The per-mandate rule is
  no longer the only thing standing between a holder and moving the same
  portion twice.
- **The evidence lineage still derives no holder**, and that part of the
  finding stands unchanged. The holder question now has an answer, but it lives
  in the Governed Authority Store where a reader can see the basis it rests on,
  rather than folded into transfer evidence where it would look like something
  the movement itself established.

What did **not** change, and why the reasoning above still holds:

- **Option B is still rejected.** Authority does not move because Soberanía believes
  a movement occurred; it moves because this deployment *accepted evidence* of
  one, and the resulting state says exactly that and no more. The position
  asserts recognized governed authority, never legal title. That is a different
  claim from the derived current-holder state rejected above, and it is the
  reason it is safe.
- **Mandate issuance still moves nothing.** Permission that is never exercised
  changes no authority.
- **Lifecycle evidence still moves nothing.** A reported reversal produces no
  inverse transition; that would let an external system rewrite Soberanía's authority
  state by reporting.
- **No transfer-specific write into the Authority Graph exists.**
  `AuthorityGrant` is unmodified. The transition is a separate, generic
  primitive, and this module hands it a recorded movement rather than mutating
  a balance itself.

## Authority-source right vs action-target right

The question `LICENSE` raised, answered from the code.

**Does the Authority Graph express "Actor X has authority over Right R"?**
**No.** `AuthorityGrant` (`src/features/authority-graph/domain/authority-grant.ts`)
carries `capability`, `actions[]` and `resourceScopes[]`, and **no
governed-right field of any kind**. Neither do `DelegationGrant`,
`RecognitionCapabilityToken`, or any authority policy.

**Does `ActionDescriptor` identify the right being acted upon?** Only inside
`action.parameters`, as opaque serialized payload the policy layer may read. No
authority check consults it.

**Does the governed-right vocabulary participate in authority evaluation?**
**No.** It is action payload semantics exclusively.

**Can right-scoped authority be expressed at all?** Only by convention.
`DelegationScopePolicy.isInScope` matches
`requested === granted || requested.startsWith(granted + ':')`, so a deployment
*may* grant `asset:work-a:usage-right` and the policy will contain it
correctly. Three measurements, all in the test suite:

1. Every governance service defaults `resourceScope` to `kind:id` — **authority
   is asset-scoped by default**, and an asset-scoped grant authorizes moving
   the economic interest, the ownership interest, or any other right.
2. A hierarchical suffix *does* contain, when the caller names it: an actor
   scoped to `…:usage-right` requesting `…:ownership-interest` is denied.
3. **The convention is unenforced.** An actor scoped to `…:usage-right` that
   names its own scope while transferring the **ownership interest** is
   `allowed`, because nothing connects the scope string to the action's target
   right.

**Finding: the distinction is semantically real and the architecture does not
express it.** Right-scoped authority is not modelled — at best it is *spelled*
by a deployment, and the spelling is never checked against what the action is
actually doing. Simulating a right-scoped check inside `TRANSFER` was refused:
it would have been an action-local invention presenting itself as an
architectural guarantee.

### Resolution status: RESOLVED

The distinction is now expressed architecturally, and — as the refusal above
insisted — not inside `TRANSFER`.

- `ActionDescriptor` carries typed `governedRights`, `governedRightsScope` and
  `governedAuthorityHolderRef`. The target right is no longer opaque payload
  that no authority check consults.
- `AocKernel` gained one optional `GovernedAuthorityProvider` port, consulted
  for every declared right, which can only narrow an already-viable outcome
  into a denial. There is no second kernel and no second authorization engine.
- The third measurement above — an actor scoped to `…:usage-right` moving the
  **ownership interest** and being `allowed` — is now **denied** with
  `AUTHORITY_GOVERNED_RIGHT_MISSING`, once the resource is enrolled. See
  `src/enterprise/__tests__/governed-authority-scenario.test.ts`.
- The first two measurements are **unchanged by design**, and this is the
  compatibility policy rather than an oversight: `AuthorityGrant` is not
  modified and still carries no governed-right field, so a bare asset-scoped
  grant over a resource this deployment has recorded no positions for still
  authorizes every right of it. Enrolment is per resource and one-way — the
  moment a resource has any position, every right of it is enforced strictly.
  See `ADR-GOVERNED-AUTHORITY-TRANSITION.md`, "Legacy authority compatibility".

`src/enterprise/__tests__/transfer-authority-transition.test.ts` is left
untouched and still passes: it builds a world with no governed authority state,
which is exactly the unenrolled case, and what it measured about that case
remains true of it.

## Protocol boundary

Answered separately, per the six questions:

- **A. Is `TRANSFER` authorization Enterprise-local?** **Yes.** Recognition,
  Authority Graph, Approval Runtime, obligations, the Kernel, the Governance
  Store and reference integrity are all Enterprise, and all were consumed
  unchanged.
- **B. Does an executed `TRANSFER` change a sovereign relationship?** **There
  is no sovereign relationship to change.** `@aoc/protocol`'s contract surface
  is `CanonicalId · UtcDateTime · ResourceRef · Delegation · Constraint ·
  ProofMetadata · CapabilityToken · ConsentGrant · ScopedAccessRequest ·
  AuditEventEnvelope · TrustDomainIdentifier` and the legacy capability,
  delegation, actor and audit contracts. `ResourceRef` is `{kind, id,
  tenantId?, attributes?}` — pure identity. **Protocol holds no owner, holder,
  controller, or sovereign-ownership record anywhere.** There is nothing for a
  completed transfer to update.
- **C. Does future Enterprise enforcement need the updated relationship?**
  **Yes** — and it does not have it. That is the gap above, and it is
  Enterprise-local: the state that would need to change is the Authority Graph,
  which is an Enterprise feature.
- **D. Can Enterprise own that state safely?** **Not on current evidence.**
  Enterprise can own it only if it is willing to treat an unverified external
  report as an authority fact, or only for transfers it can independently
  verify. Neither is true today.
- **E. Does the updated relationship need to cross Enterprise deployments?**
  **Not demonstrated.** Every identity in this action is opaque and
  deployment-local. A cross-deployment transfer — where the recipient is
  governed by a *different* Frontera Systems instance — would be a genuine
  cross-sovereignty requirement, and this implementation produced no such case.
- **F. Does Protocol therefore need a new primitive?** **Not yet.**

**Classification: `PROTOCOL CHANGE NOT YET REQUIRED, BUT AUTHORITY-TRANSITION
GAP IDENTIFIED`.** The gap is Enterprise-local on current evidence. It would
become a Protocol question only if authority transitions had to be recognized
across independently-governed deployments — which `TRANSFER` did not
demonstrate and which must not be implemented speculatively.

### Resolution status: confirmed, and answer D revised

Re-evaluated once the Enterprise foundation existed. The classification is now
`ENTERPRISE FOUNDATION SUFFICIENT; PROTOCOL PORTABILITY DEFERRED`, and
`@aoc/protocol` remains untouched — its consumption, contract-adoption and
compatibility-lock checks all pass unchanged.

A, B, C, E and F above stand as written. **D is revised**: "Can Enterprise own
that state safely?" was answered *not on current evidence*, on the grounds that
owning it would mean treating an unverified external report as an authority
fact. The foundation answers it **yes**, by narrowing the claim rather than by
acquiring verification. A position asserts recognized governed authority within
this deployment, explicitly not legal title, and every position can name the
basis it rests on. That is a proposition Enterprise can own honestly and one
that is sufficient for Soberanía's own subsequent enforcement.

The thresholds that would make this a Protocol question are unchanged and still
unmet: an authority position having to cross Enterprise boundaries, two
independent deployments needing common sovereign state, portable proof of a
transition, or a resource's sovereignty anchor changing independently of any one
installation.

## Known limitations

- **No authority transition.** The finding above. A recipient must be granted
  authority administratively. *(Resolved — see "Resolution status" under
  "Post-transfer authority".)*
- **No right-scoped authority.** The finding above. *(Resolved — see
  "Resolution status" under "Authority-source right vs action-target right".)*
- **Transferor holdings are not tracked.** Soberanía knows how much each *mandate*
  authorized and how much moved under it. It does not know how much a party
  holds, so two mandates can each authorize 25% of the same interest.
  *(Partially resolved.* Holdings are now tracked, and a transferor's remaining
  authority is checked before a mandate is issued. The over-authorization half
  is **deliberately still open**: authorization reserves nothing, so two
  mandates may still each be authorized against the same holdings, and only the
  second execution is refused. See `ADR-GOVERNED-AUTHORITY-TRANSITION.md`,
  "Reservation decision", for why reservation was deferred and how the residual
  risk is bounded.*)
- **The privileged-writer limitation is unchanged.** Digests detect
  after-the-fact corruption; they are not signatures. `TRANSFER` supplied no
  new sovereignty-boundary anchor requirement, so no signing, HSM, transparency
  log, attestation or Protocol anchoring is proposed here.
- **No provider integrations.** No registry, transfer agent, custodian,
  settlement, escrow or payment adapter exists or is implied.
- **No reversal, rescission or return action.**

## Generalization findings

Recorded in full in
`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`. In brief,
`TRANSFER` confirmed the governed-right vocabulary (and settled *why* it is
asset-side), confirmed the seventeen-field mandate skeleton at 4/4 with zero
extras, confirmed validity/revocation, expanded the proven execution-evidence
envelope, supplied the fourth data point that resolved lifecycle evidence,
independently re-falsified universal executor binding, and — for the first time
— authorized an extraction: `@aoc-enterprise/governed-authorization`.
