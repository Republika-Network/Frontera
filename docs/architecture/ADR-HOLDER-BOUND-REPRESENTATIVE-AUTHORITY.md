# ADR: Holder-bound representative authority

**Status:** Accepted
**Supersedes:** nothing
**Extends:** `ADR-GOVERNED-AUTHORITY-TRANSITION.md`
**Companion doc:** `docs/enterprise/AOC_GOVERNED_REPRESENTATIVE_AUTHORITY.md`

## Context: the gap the governed-authority foundation left

The previous foundation gave Frontera Systems the ability to say *which party
controls which governed right, and how much of it*, and to move that authority
when a governed execution completes. It closed two questions:

> WHO HOLDS THE GOVERNED AUTHORITY?
> HOW MUCH DO THEY HOLD?

It also, deliberately and correctly, separated `requestedBy` from
`governedAuthorityHolderRef`. `GovernedAuthorityQuery.holderRef` carries a
comment saying precisely why:

> Whose authority is being drawn on — **not** necessarily who is asking. [...]
> a portfolio manager submits a transfer of Party A's economic interest, so the
> Authority Graph must authorize the *manager* to act while this layer must
> confirm that *Party A* holds what is moving.

What that separation did not do — and could not, by itself — was constrain
*which* Party A a given manager may name. Both checks were enforced, and both
were satisfiable **independently, by different parties**:

- the Authority Graph confirmed the manager may invoke `TRANSFER` on Asset A;
- the governed-authority layer confirmed the named holder controls enough.

Nothing related the two. The remaining question was:

> WHY MAY THIS REQUESTER EXERCISE *THAT* HOLDER'S AUTHORITY?

### The measurement

Not assumed — measured, against the real runtimes, before anything was written.
Alice seeded with 7 500 bp and Bob with 2 500 bp of the economic interest of one
asset; `actor-rights-manager` given one bare asset-scoped `AuthorityGrant`
covering all four governed actions, and **zero** governed authority of its own:

```
X acting for ALICE   -> allowed
X acting for BOB     -> allowed
X licensing for BOB  -> allowed
manager's own position: null
```

The inference "I may perform this action on this asset, therefore I may choose
whichever holder has enough rights" was fully available, on every one of the
four governed actions.

## Why the existing delegation model could not close it

The obvious move — read the holder relationship out of the Authority Graph
chain that already exists — was investigated first and rejected on four
independent grounds, any one of which would have been sufficient.

**1. Namespace mismatch (decisive).** `GovernedAuthorityPosition.actorRef` is a
*party reference*, documented as "not necessarily a Recognition Runtime actor:
the holder of an economic interest need not be an actor that can call
anything". `DelegationGrant.delegatorActorId`, `delegateActorId` and
`principalActorId` are trust-domain *actor ids*. There is no mapping between
the two, and inventing one — `holder:alice` inside `resourceScopes[]`, or any
equivalent string convention — would have made the holder relationship an
untyped parsing accident rather than semantics.

**2. `principalActorId` is not a proof.**
`DelegationService.createDelegationGrant` computes it as
`input.principalActorId ?? source.principalActorId ?? input.delegatorActorId`
and validates it against nothing whatever. `AuthorityChain.principalActorId` is
likewise `request.principalActorId ?? delegations[0]?.principalActorId` — a
caller-declared value that `requiresAuthorityChain()` uses only to decide
*whether to resolve a chain at all*. It is a routing hint. Treating a hint as
security evidence is how this class of hole is made, not closed.

**3. The measured vulnerability involves no delegation at all.** The manager's
authority is a **direct** `AuthorityGrant` — issuer: the organization, subject:
the manager. There is no `DelegationGrant` anywhere in the path, so there is
nothing to read a principal *from*. Any design that depended on delegation
records existing would have left the actual measured case wide open.

**4. Neither grant type carries the required dimensions.** No governed right,
no `GovernedRightsScope`. `AuthorityConstraint`'s `max_amount` is
`{ currency, value }` — a monetary limit, not a quantity of a right. Adding
these would have meant changing a contract four actions and the whole Authority
Graph already depend on, to carry vocabulary only this layer understands.

## Decision

Introduce **`GovernedRepresentativeAuthority`**: an adjacent, typed, durable
binding that says one party may exercise another party's governed authority,
bounded on seven dimensions, resting on a closed basis union, and enforced
through its own narrow Kernel port.

Explicitly **not** done:

- `AuthorityGrant` — untouched, exactly as the previous foundation left it.
- `DelegationGrant` — untouched.
- `GovernedAuthorityPosition` — untouched; no `representativeRefs[]` added.
- `ActionDescriptor` — untouched; `governedAuthorityHolderRef` already existed
  and already carried the right thing.
- The four actions' terms — untouched. No integration field was needed.
- The Protocol — untouched.
- No new package.
- No `DELEGATE` governed action.

## What exactly is delegated

This needed an explicit answer, because three plausible ones are wrong.

The representative is **not** delegated the underlying right — the holder keeps
it. It is **not** delegated the authority position — positions are not
transferable objects. It is **not** given a share of the holder's quantity —
nothing is debited or credited by a grant.

What is delegated is **the ability to cause Soberanía to evaluate the holder's
governed authority for a request, within a bounded envelope**. The
representative supplies the request; the holder supplies the authority; the
Kernel combines the two for the duration and scope of that one request and no
longer.

## Terminology

`holder` and `representative` are the two roles. `requester` is the runtime
caller — identical to the representative on the delegated path, and identical
to the *holder* on the direct one.

**"Principal" is deliberately not adopted.**
`DelegationGrant.principalActorId` already exists with a different meaning in a
different namespace, and reusing the word would have made two unrelated things
look like one. This is the same discipline that produced `holder` rather than
`owner` in the previous foundation.

## Store: yes, and why it could not be derived

**Answer: YES, representation needs its own durable store.**

It cannot be derived from existing delegation state for the four reasons above:
the namespaces do not meet, the only principal field is unvalidated, the
measured case contains no delegation record at all, and neither grant type
carries a governed right or a rights scope. There is nothing to derive *from*.

It is a **separate** store from the Governed Authority Store, not more columns
on it, and that separation is load-bearing rather than tidy:

- a holder's authority state must not be rewritten — and its digest re-sealed —
  every time an administrator is appointed or removed;
- a representation's lifecycle (withdrawal, redelegation, validity windows) has
  nothing in common with a position's (conservation, exhaustion);
- the two are consulted at different points, through different ports, by
  different questions.

One table would have coupled a governance-personnel change to an
authority-ledger write.

**What is *not* duplicated:** `DelegationGrant` lifecycle. A representation
grounded in a delegation records only the grant's id and trust domain, and the
grant's liveness is re-resolved at **every evaluation** through an injected
lookup port. Revoking the delegation disables the representation with no row in
this store changing. The same applies to redelegation chains, which are walked
to the root at evaluation rather than cached into descendants.

## Record model

```
id, tenantId
holderRef                       party ref — matched against a position holder
representativeRef               actor ref — matched against requestedBy
resourceKind, resourceId
governedRights[]                enumerated; empty is refused, never a wildcard
scopeLimit                      { bounded, maximum } | { unbounded }
actions[]                       enumerated; empty is refused, never a wildcard
effectiveFrom, expiresAt?
canRedelegate, delegationDepth, parentRepresentativeAuthorityId?
basis                           closed union of four
revokedAt?
createdAt, updatedAt, correlationId?, digest
```

Two shape decisions worth recording:

**`scopeLimit` is a discriminated union, not an optional maximum.** An omitted
optional ceiling would have been the most permissive possible binding *and* the
easiest one to create by accident. Making "unbounded" cost an explicit word
puts the permissive case where a reviewer can see it.

**`revokedAt` is stored; state is derived.** `GovernedAuthorityPosition`
deliberately stores no status because every one of its states is a function of
scope and time. Here, revocation genuinely is not derivable from anything else —
so the *event* is recorded as one instant, and `pending`/`active`/`expired`/
`revoked` remain a total function of `revokedAt`, `effectiveFrom`, `expiresAt`
and now. The discipline is the same; only the minimum stored fact differs.

## Basis and issuance

Four variants, closed, with no `self-asserted` and no free-text.

Creation of any *issuing* basis requires `context.system` — the same boundary
`bootstrapPosition` sits behind, and for a stronger reason: a grant path
reachable by a delegated administrator about itself would reopen the exact hole
this layer closes, one function call lower down.

`authority-graph-delegation` is corroborated rather than trusted. The named
grant must be **active**, in the stated trust domain, delegated **to** the
representative, and held **for** the holder. This is the provenance rule: a
grant originating from or held for a third party is not evidence about this
holder, however broad it is. A basis naming a delegation with **no lookup
configured is refused** — a basis nothing can corroborate is not evidence.

`representative-redelegation` is the one non-privileged path, and it is safe
structurally rather than by policy: it *cannot create anything*. Holder and
resource are copied from the parent rather than supplied — there is no field
into which a different holder could be written — and the remaining five
dimensions are checked for containment.

### The limitation, stated rather than papered over

For a deployment whose holder references are **not** actor ids, the
`authority-graph-delegation` basis cannot corroborate anything, because the
principal it compares against lives in a different namespace. Such a deployment
has exactly two production paths: `recognized-external-representation`, backed
by evidence it already accepts, or `administrative-bootstrap`. Both are
administrative and both require a privileged context. We are not claiming a
delegation-derived issuance path exists where it does not.

## Kernel integration

A **second** narrow port, `GovernedRepresentationProvider`, beside
`GovernedAuthorityProvider` — not a widening of it. The two answer different
questions, fail for disjoint reasons, and are independently configurable;
folding them would have forced one coverage union to carry two verdicts and
would have left a denial unable to say which of the two proofs was missing.

No `RepresentativeKernel`, `DelegationKernel`, `ProxyKernel` or `AgencyKernel`.
`AocKernel` remains the only component in Frontera Systems that decides.

Both facts are resolved in one step, because they share everything the
resolution needs — tenant, resource, right list, instant — and because a caller
must not be able to run one without the other.

**Narrowing only.** The step runs after the wrapped engine's chain and against
an outcome it already found viable. It can turn viable into denied and nothing
else. A representation cannot rescue a missing capability, a revoked token, or
an out-of-scope grant, and this is asserted directly rather than assumed.

**Enrolment gates it.** Representation is required only where the
governed-authority check reports the resource as *enrolled*. This is not a
second compatibility policy — it reuses the signal the first one already
produces, which makes representation enforcement exactly co-extensive with
right-scoped authority enforcement, and makes enrolment's one-way property apply
to both for free.

## Legacy delegation compatibility

**Can a legacy action/resource `DelegationGrant` allow requester X to act for
holder Alice on an enrolled governed-authority resource? No.**

There is no proof tying X to Alice in such a grant — see the four reasons above.
Reinterpreting historical delegations as holder-bound would have granted every
delegate authority over every holder on every enrolled resource, which is the
vulnerability rather than a migration of it. Deployments migrate by issuing
explicit representations; the `authority-graph-delegation` basis makes that
mechanical wherever the delegation genuinely names the holder as its principal.

Unenrolled resources are entirely unaffected, and a deployment that has not
configured the provider is byte-for-byte unchanged. That is the same adoption
shape the governed-authority provider itself used one change ago, and choosing
it again is what keeps this a narrow hardening rather than a breaking IAM
migration.

## Temporal boundary: revocation and issued mandates

**Decision: MANDATE REMAINS VALID.**

A representation revoked after a mandate was issued does not invalidate that
mandate. Only new issuance is blocked.

```
representative authority   permission to cause Enterprise to ISSUE an authorization
mandate                    a durable authorization Enterprise has ALREADY issued
```

The justification is repository evidence rather than preference: nothing in
existing Enterprise authorization semantics revokes an issued mandate when the
authority behind its issuance later lapses. Mandates carry their own expiry and
their own revocation events, and the four action modules treat revocation as a
distinct lifecycle act. Introducing a silent cascade here would have been a new
governance act invented by this change rather than an implementation of one, and
a cascade is far harder to remove later than to add. A deployment that wants
issued mandates withdrawn when a representative is removed does so through the
mandate revocation path that already exists.

Asserted, not assumed, in `governed-representation-scenario.test.ts`.

## Redelegation

Supported, and monotone on seven dimensions checked together in one place —
`governedRepresentativeAuthorityContainmentBreach`. Splitting them across call
sites is exactly how six get verified and the seventh forgotten.

Holder and resource are structurally immune (copied, not supplied). Rights,
actions, ceiling and both ends of the validity window are containment-checked. A
child that never ends cannot derive from a parent that does.

Because the chain is resolved at evaluation, revoking an ancestor disables its
whole subtree immediately, with no descendant rewritten.

## Audit lineage

No mandate contract changed, and none needed to. A mandate already records
`requestedBy`, and the action terms already name the holder — so "who acted",
"for whom", and "on what resource" are all reconstructible from what was already
stored, and the binding that permitted it is reachable from those three values.
Adding a `representativeAuthorityId` field to four mandate contracts to
duplicate a derivable reference was rejected.

The `KernelEvaluationResult.authority.representation` block carries the live
detail: the two parties, per-right outcomes, the binding relied on, and the full
chain when a redelegation authorized the request.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Extend `DelegationGrant` with holder/right/scope | Wrong namespace; `principalActorId` unvalidated; breaks a contract the whole Authority Graph shares; and the measured case has no delegation record at all |
| Extend `AuthorityGrant` | Same, plus the previous foundation deliberately left it untouched |
| Resolve holder identity from the existing chain | There is nothing to resolve *from* — see the four reasons |
| Encode `holder:alice` in `resourceScopes[]` | An untyped string convention as the semantic proof of a security relationship |
| `representativeRefs[]` on `GovernedAuthorityPosition` | Rewrites and re-seals a holder's authority state on every administrator change |
| A separate `@aoc-enterprise/governed-representation` package | Identical dependency set, same subject; packaging as decoration |
| Widen `GovernedAuthorityProviderPort` | One union carrying two verdicts; a denial could not say which proof was missing |
| A `DELEGATE` governed action | This is authority infrastructure, not a domain action; see below |
| Fail closed with no provider configured | Would deny every existing deployment's delegated requests on the day it shipped, for the same reason the previous foundation chose per-resource enrolment |

## Protocol boundary

**Does holder-bound representative authority require the Protocol? No.**

The Protocol holds no owner, holder or controller state; this layer is
Enterprise-local governance configuration, exactly as `AuthorityGrant` and
`GovernedAuthorityPosition` are. `check:protocol-consumption`,
`check:protocol-contract-adoption` and `check:protocol-compatibility-lock` all
pass unchanged.

The threshold at which this would become a Protocol question is specific and has
not been reached: holder-bound delegation would have to become **portable across
independent sovereign deployments** — one deployment proving to another that a
representative legitimately represents a holder. Nothing today requires that,
and building portability for a requirement nobody has is how a Protocol acquires
vocabulary it cannot later remove.

## Future `DELEGATE` threshold

**NOT YET.**

This change is authority infrastructure. Creating a representation is an
administrative act with a privileged basis, not a domain-level exercise of a
governed right — it debits nothing, credits nothing, and produces no external
effect for a provider to execute and evidence. The four existing governed
actions all move, encumber, permit or represent an asset's rights in the world;
this moves nothing.

The evidence that would change the answer is concrete: if creating a
representation ever needs its own policy evaluation, approval workflow,
obligations, external execution evidence, or a durable mandate that a provider
acts on, it will have become a governed action in substance and should be made
one in form. None of that is true today, and building `DELEGATE` now would be a
fifth action with no domain behind it.

## Known limitations

- **No delegation-derived issuance where holder refs are not actor ids.** Stated
  above rather than papered over; such deployments use the two administrative
  bases.
- **No reservation.** A ceiling is not a lien. Execution-time conservation
  remains the model, unchanged and deliberately so.
- **No cross-store atomicity.** Representations, positions, mandates and
  governance records live in separate stores, and this change does not pretend
  otherwise. Reads validate, creation is idempotent, and consistency boundaries
  are documented rather than faked.
- **No revocation cascade onto issued mandates.** Decided above.
- **No representation-level approval workflow.** Creation is administrative.
- **Cycle protection is a hop limit.** Creation validation makes a cycle
  unreachable, and the resolver additionally caps chain walks at 16 hops rather
  than trusting that.

## Consequences

The inference this change exists to retire no longer type-checks against
reality: a requester that may perform an action on a resource can no longer
choose whichever holder has enough rights. It may act only for holders it is
explicitly, verifiably, and revocably bound to — and it never acquires their
authority by acting for it.
