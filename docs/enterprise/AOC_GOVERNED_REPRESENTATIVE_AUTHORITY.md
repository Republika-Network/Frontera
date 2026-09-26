# Soberanía Holder-Bound Representative Authority

The state Frontera Systems keeps about **which party may exercise another
party's governed authority**, within what envelope, and on what basis.

Companion to `docs/architecture/ADR-HOLDER-BOUND-REPRESENTATIVE-AUTHORITY.md`,
which records why each decision below was made rather than what it is, and to
`AOC_GOVERNED_AUTHORITY.md`, which describes the underlying authority this
layer permits the exercise of but never confers.

## The three authority questions

Frontera Systems now distinguishes three questions that were previously two. All
three are independent, and none substitutes for another.

```
A. ACTION AUTHORITY          May requester R invoke action Y on resource X?
   AuthorityGrant / DelegationGrant / Recognition Runtime / Authority Graph

B. UNDERLYING GOVERNED       Which governed right does holder H control,
   AUTHORITY                 and how much of it?
   GovernedAuthorityPosition

C. REPRESENTATIVE AUTHORITY  May requester R exercise holder H's authority?
   GovernedRepresentativeAuthority
```

**The invariant.** For a governed action where the requester is not the holder,
the action proceeds only when all three hold:

> Requester R has action authority for this action on this resource,
> **and** R is authorized to represent holder H for this right, action and
> quantity, **and** H holds sufficient governed authority over that right.

Where the requester *is* the holder, C does not apply and is not required: a
party does not delegate to itself.

## The gap this closes

Until this layer existed, A and B were both enforced and both satisfiable
*independently, by different parties*. A delegated administrator holding a bare
asset-scoped grant — and holding no governed right at all — could name whichever
holder happened to have enough, and nothing in the path objected. The inference

> I may perform `TRANSFER` on Asset A, therefore I may choose whichever holder
> has enough rights.

had nothing standing against it. It no longer exists: an administrator may act
only for holders it is explicitly bound to.

That behaviour was measured before the change and is measured again after it in
`src/enterprise/__tests__/governed-representation-scenario.test.ts`, "the
arbitrary-holder vulnerability".

## The bounded proposition

A representation asserts exactly this:

> According to the governance state this Frontera Systems deployment recognizes,
> Representative R may cause Holder H's authority over Rights [...] of
> Resource X to be exercised, for Actions [...], up to Ceiling C, between
> `effectiveFrom` and `expiresAt`.

It does **not** assert that the representative holds, owns, or beneficially
acquires any part of the holder's right. It is not legal agency, power of
attorney, or a status recognized by any authority outside this deployment. The
proposition is exactly as strong as the governance state behind it, which is the
same bound `GovernedAuthorityPosition` and `AuthorityGrant` already accept.

## Vocabulary

| Term | What it is |
| --- | --- |
| **Holder** | The party whose `GovernedAuthorityPosition` is exercised. A party reference, in the same namespace as `GovernedAuthorityPosition.actorRef` — not necessarily an actor that can call anything. |
| **Representative** | The party authorized to exercise the holder's authority. Compared against the request's `requestedBy` / `actor.id`. |
| **Requester** | The runtime caller. Identical to the representative when the two differ from the holder; identical to the *holder* on the direct path. |
| **Representation** | One `GovernedRepresentativeAuthority` record: the holder-bound envelope. |
| **Basis** | Why this deployment recognizes the representation. A closed union of four. |
| **Scope limit** | The representative's quantity ceiling. `bounded` with an exact maximum, or `unbounded`. |
| **Redelegation** | A representation derived from another, never wider on any dimension. |

"Principal" is deliberately **not** introduced as a synonym for holder.
`DelegationGrant.principalActorId` already exists in the Authority Graph with a
different meaning and a different namespace, and reusing the word would make
two unrelated things look like one.

## What binds, and on how many dimensions

A representation is bound on seven dimensions, and every one of them is
enforced independently:

| Dimension | A binding for | does not authorize |
| --- | --- | --- |
| **Holder** | acting for Alice | acting for Bob — *even where Bob holds more than enough* |
| **Resource** | Asset A | Asset B |
| **Right** | `usage-right` | `ownership-interest` |
| **Action** | `LICENSE` | `TRANSFER` |
| **Scope** | up to 2 000 bp | 2 001 bp |
| **Start** | from 1 June | 1 May |
| **End** | until 31 December | 1 January |

## Ceiling, not reservation

The representative's ceiling and the holder's current position constrain the
action **independently**, and the effective amount is the intersection of the
two. Neither is derived from the other, and neither is a numeric `min` — both
are containment checks through the canonical scope primitives, so a proportional
ceiling never silently bounds a unitized request.

```
Alice holds 7 500 bp,  R may act up to 2 000 bp
  request 1 500 -> both satisfied
  request 2 500 -> denied by the representative ceiling  (Alice could do it herself)

Alice holds 1 500 bp,  R may act up to 5 000 bp
  request 2 000 -> denied by the holder's position       (the ceiling permits it)
```

Creating a representation **reserves nothing**. If the holder subsequently moves
authority away directly, the representative's usable amount falls with the
holder's position and no record here is rewritten; if the holder later receives
more, the representative may exercise more, up to the unchanged ceiling. A
representation is a ceiling over dynamically resolved holder state, never a
snapshot of holdings and never a lien on them.

That remains exactly true now that `GovernedAuthorityReservation` exists, and
the two answer different questions:

> **Representative authority** answers "*who* may exercise Holder H's
> authority?"
>
> **Reservation** answers "*how much* of H's authority remains available for a
> new commitment?"
>
> **Encumbrance** answers "*how much* of H's authority stays constrained after a
> governed action has already executed?"

A representation still reserves nothing at the moment it is granted, and
constrains nothing at any moment. What reserves is a governed authorization
actually being issued; what constrains is one actually executing — and in both
cases the record is against **the holder**, never against the representative,
who acquires nothing and is constrained by nothing. Two independent
representatives of the same holder therefore draw on one pool, both before and
after execution: a 3 000 bp commitment made through R leaves 2 000 bp for R2,
and so does a 3 000 bp constraint left behind by R's completed
collateralization, even though the two bindings know nothing of each other. See
`AOC_GOVERNED_AUTHORITY_RESERVATION.md` and
`AOC_GOVERNED_AUTHORITY_ENCUMBRANCE.md`.

These are independent dimensions, and neither implies the other. A
representation over an encumbered holder is exactly as valid as one over an
unencumbered holder — the constraint bounds *how much*, never *who* — and a
constraint confers no representation on the secured party, the executor or
anyone else named anywhere near it.

`unbounded` is the deliberate "no numeric limit of *my own*" ceiling. It is not
"100%" and not "everything forever": the holder's current position remains the
hard cap at every instant. It is a discriminated variant rather than an omitted
optional field, so the most permissive binding costs an explicit word instead of
being reachable by forgetting one.

## No conservation, no credit

Granting or revoking a representation changes **no** `GovernedAuthorityPosition`.
The holder's position is unchanged; the representative's is unchanged (and
typically does not exist). Only an authority-changing governed execution — a
completed `TRANSFER` — moves authority, and it moves it **from the holder**:

```
Alice 7 500 bp  ->  R, bound to Alice, transfers 1 500 to Carol  ->  executed
Alice 6 000     Carol 1 500     R still holds nothing at all
```

The recorded `GovernedAuthorityTransition` names Alice as `fromActorRef` and
Carol as `toActorRef`. The representative is never recorded as the source
holder; it is recorded as the mandate's `requestedBy`, which is what it was.

## Who may create one

Creation is a **store operation reachable only from a privileged system
context** — never a request an actor could submit about itself, and never a
route, handler or governed action. This is the same boundary
`bootstrapPosition` sits behind, and for the stronger reason: if a delegated
administrator could reach a grant path about itself, the hole this whole layer
closes would reopen one function call lower down.

The one non-privileged path is **redelegation**, and it is safe structurally
rather than by policy: it cannot create anything. Its holder and resource are
*copied* from the parent rather than supplied — there is no field on a
redelegation into which a different holder could be written — and every other
dimension is checked for containment. A tenant context may redelegate only when
the caller *is* the parent's representative.

## Bases

A closed union of four. There is no `self-asserted` variant and there never may
be.

| Basis | Requires | Corroboration |
| --- | --- | --- |
| `administrative-bootstrap` | system context | none; it *is* the administrative assertion |
| `authority-graph-delegation` | system context + a configured delegation lookup | the named `DelegationGrant` must be **active**, in the stated trust domain, delegated **to** the representative, and held **for** the holder |
| `recognized-external-representation` | system context | a non-empty `evidenceRefs` |
| `representative-redelegation` | the parent's representative, or system | full containment within the parent |

The `authority-graph-delegation` corroboration is the **provenance property**: a
delegation held for Carol is not evidence that a representative may act for
Alice, however broad that delegation's actions and resource scopes happen to be.
A basis referencing a delegation with no lookup configured is **refused**, not
trusted — a basis nothing can corroborate is not evidence.

## Redelegation

Supported, and monotone on every dimension. A child may narrow the rights, the
actions, the ceiling and either end of the validity window; it may broaden none
of them, and it cannot change the holder or the resource at all. Depth is
recorded, and the chain is walked to its root at every evaluation.

```
Alice -> X  (5 000 bp, TRANSFER, canRedelegate)
X     -> Y  (2 000 bp, TRANSFER)          valid
X     -> Y  (7 000 bp)                    refused: scope expansion
X     -> Y  (+ ownership-interest)        refused: right expansion
X     -> Y  (+ LICENSE)                   refused: action expansion
X     -> Y  (Asset B)                     ignored; the parent's resource is copied
X     -> Y  (acting for Bob)              ignored; the parent's holder is copied
```

Because the chain is **resolved rather than cached**, revoking `Alice -> X`
immediately makes `Y`'s representation unusable, and no descendant record is
rewritten. Grant lifecycle stays where it belongs.

## What revocation does and does not reach

Withdrawing a representation stops future requests by that representative for
that holder. It does **not**:

- revoke the holder's `GovernedAuthorityPosition`, or any other party's;
- revoke any other representative's binding for the same holder;
- undo a governed execution that already happened;
- reverse a `GovernedAuthorityTransition` that was already committed;
- revoke a `TokenizationMandate`, `CollateralizationMandate`, `LicenseMandate`
  or `TransferMandate` — those have their own lifecycle events;
- invalidate a mandate that was already issued.

Withdrawal is idempotent, and a retry does not move the instant it happened.

## Representation and mandates: the temporal boundary

**A representation revoked after a mandate was issued does not invalidate that
mandate.** The already-issued mandate remains executable; only *new* mandate
issuance is blocked.

```
representative authority   permission to cause Enterprise to ISSUE an authorization
mandate                    a durable authorization Enterprise has ALREADY issued
```

Nothing in existing Enterprise semantics revokes an issued mandate when the
authority behind its issuance later lapses — mandates carry their own expiry and
their own revocation events — and introducing a silent cascade here would be a
new governance act rather than an implementation of one. A deployment that wants
issued mandates withdrawn when a representative is removed does so through the
mandate revocation path that already exists.

Asserted directly in `governed-representation-scenario.test.ts`, "a mandate
already issued survives a later withdrawal, and still executes".

## Enforcement

`AocKernel` remains the only component that decides. The representation
resolver produces one fact and no decision.

The step runs **after** the wrapped engine's own chain and can only ever narrow
an already-viable outcome into a denial. It cannot rescue a denial, cannot
upgrade `approval_required` to `allowed`, and cannot produce an `allowed` the
recognition/authority/policy/approval chain did not already produce. A
representation therefore never gets a request past a missing capability, a
revoked token or an out-of-scope grant.

Evaluation order for a delegated request:

```
1. Recognition Runtime / Authority Graph   is R eligible to request this at all?
2. Representative authority                may R act for H?
3. Governed authority                      does H hold the right, and enough?
4. Policy, approvals, obligations
5. Kernel decision
```

Reason codes — three, mirroring the three governed-authority codes one for one:

| Code | Meaning |
| --- | --- |
| `AUTHORITY_REPRESENTATION_MISSING` | no binding covers this holder, right and action — including "a binding exists, for a different holder" |
| `AUTHORITY_REPRESENTATION_SCOPE_EXCEEDED` | over the ceiling, or a quantity not commensurable with it |
| `AUTHORITY_REPRESENTATION_EXPIRED` | outside the window, withdrawn, or the basis under it lapsed |

Finer causes — wrong holder, wrong right, wrong action, over ceiling, revoked,
basis withdrawn — are preserved verbatim in
`KernelEvaluationResult.authority.representation`, per right. Three codes is
what an integrator programs against; the outcome is what a reviewer reads.

## Legacy compatibility

Enforcement is **per-resource and opt-in**, gated by exactly the enrolment
signal the governed-authority layer already produces. Representation is required
only when all three of these hold:

1. a representation provider is configured;
2. the requester differs from the holder;
3. the resource is **enrolled** — this deployment holds some governed authority
   state for it.

A resource nothing has been recorded against behaves precisely as it did before
either layer existed. The moment a resource has any position at all, the holder
identity becomes security-sensitive and this fails closed for every right of
that resource, including rights nobody was bootstrapped into. Enrolment is
one-way: it is inherited from `isResourceEnrolled` and cannot be undone by
exhausting or removing positions.

**An existing action/resource `DelegationGrant` does not, by itself, prove which
holder a delegate may act for.** It proves the delegate may invoke the action.
On an enrolled resource, acting for someone else additionally requires an
explicit holder-bound representation. Deployments that want legacy delegations
to keep working across holders must issue the corresponding representations —
the `authority-graph-delegation` basis exists to make that migration mechanical
where the delegation genuinely names the holder as its principal.

## Where it sits

```
@aoc-enterprise/governed-authorization      right + scope vocabulary
        |
@aoc-enterprise/governed-authority          positions, transitions, representations,
        |                                   and the two coverage ports  (pure data)
        |
src/enterprise/authority-governance/        both stores, both resolvers  (runtime)
        |
src/kernel/                                 two optional provider ports
```

The representation vocabulary lives in `@aoc-enterprise/governed-authority`
rather than in a package of its own: it has an identical dependency set, adds no
new edge, and is about the same subject — governed authority, and who may
exercise it. A separate package would have been packaging as decoration.

## Trust boundary

This layer is **Enterprise-local**. It requires no Protocol capability and no
Protocol change: the Protocol holds no owner, holder or controller state, and
there is no demonstrated requirement for one deployment to prove to another that
a representative legitimately represents a holder. Should holder-bound
delegation ever need to be portable across independent sovereign deployments,
that would be the threshold at which the question becomes a Protocol one. It has
not been reached.

## Durability, concurrency, integrity

Two store implementations behind one behavioural contract, run twice by
`governed-representation-store-contract.test.ts`. Every mutating call is a
single synchronous critical section, so a redelegation cannot validate against a
parent that a concurrent revocation is in the middle of withdrawing. The
delegation-port lookup happens *before* the transaction opens: a write lock is
never held across an asynchronous call.

Every field a tamper could widen — holder, representative, resource, rights,
actions, ceiling, window, basis, redelegation permission, withdrawal instant —
is covered by the row digest, and a read that finds a mismatch **fails closed**.
Two invariants are pushed into the database rather than only enforced above it:
`CHECK (holder_ref <> representative_ref)` and the idempotency-key uniqueness
constraint.

Creation is idempotent on an optional `idempotencyKey`; the same key with
materially different terms is refused as a conflict rather than reinterpreted.

## The fourth question, added later

A later foundation added a question adjacent to this one. The two are close
enough to be confused and must not be, so the distinction is recorded here
rather than only in the newer document:

```
REPRESENTATIVE AUTHORITY   May requester R exercise holder H's authority?
                           GovernedRepresentativeAuthority

DERIVED AUTHORITY LINEAGE  Through what bounded chain does R possess the
                           capability to make this request at all, and is
                           every link in that chain still valid now?
                           DelegationGrant / DelegatedCapability lineage
```

Nothing in this document changes. Representation still answers only its own
question, is still required independently, and is still incapable of rescuing a
denial from any other layer. What the newer layer adds is that R's *capability*
must itself be a legitimate, non-amplifying, still-live derivation — which is a
separate proof that a valid representation does not supply, and which does not
supply a valid representation.

Concretely: delegating a capability to an agent does **not** delegate the
ability to represent the holders the delegator represents. An agent with a
flawless delegation over an asset still cannot name a holder it is not itself
bound to.

See `AOC_DELEGATED_CAPABILITIES_DERIVED_AUTHORITY.md` and
`docs/architecture/ADR-NATIVE-DELEGATED-CAPABILITIES.md`.

## Where representation does not apply: governed encumbrance release

`RELEASE_ENCUMBRANCE`, the fifth governed action, is authorized by Action
Authority alone. Holder-bound representation plays **no part** in it, and the
reason is worth stating precisely, because the surface reading points the other
way: a release visibly concerns a constraint over Alice's authority, so it looks
as though the requester ought to be bound to Alice.

It ought not, because a release exercises nothing of Alice's. It ends a
constraint rather than drawing on a fraction of a right, so its request declares
no `governedRights`, the Kernel's governed-authority check is correctly
`not_performed`, and there is no holder's authority being exercised for a
representative to be *bound to*. Requiring representation of the encumbered
holder would have asserted the opposite — that discharging a constraint is an
exercise of the constrained authority — and, worse, would have implied that
Alice controls whether her own constraint ends. She does not: being the
encumbered holder confers no release authority at all.

If a deployment ever introduces a distinct release-authority *principal* that a
requester acts for, representation would become the right question about **that**
principal — never automatically about the encumbered holder. See
`AOC_GOVERNED_ENCUMBRANCE_RELEASE.md`, "Who may release".

## Not implemented, deliberately

- **No `DELEGATE` governed action.** This is authority infrastructure, not a
  fifth domain action. See the ADR's "Future `DELEGATE` threshold".
- **No generic reservation, and no encumbrance.** A ceiling is neither a
  commitment nor a constraint: granting a representation neither reserves nor
  encumbers anything, and revoking one neither releases nor discharges anything.
  Those quantities live in `GovernedAuthorityReservation` and
  `GovernedAuthorityEncumbrance`, against the holder.
- **No separate constraint pool.** Persistent constraints are holder-bound, and
  applicability follows the *holder's* authority state rather than the
  requester's identity. A representative — however impeccable its
  representation, and however high its ceiling — draws on exactly the pool the
  holder has, and two representatives of the same holder compete for it. Acting
  for someone buys no capacity. See
  `AOC_GOVERNED_CONSTRAINT_APPLICABILITY.md`, "Binding".
- **No revocation cascade onto issued mandates.** See the temporal boundary
  above.
- **No representation on the position record.** A holder's authority state must
  not be rewritten every time an administrator changes.
- **No `AuthorityGrant` or `DelegationGrant` modification.** Both are untouched.
