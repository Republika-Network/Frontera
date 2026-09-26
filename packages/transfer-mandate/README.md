# `@aoc-enterprise/transfer-mandate`

Enterprise-owned, provider-neutral, immutable contracts for the `TRANSFER`
governed action.

`TRANSFER` means: **authorizing the movement of specified governed rights
associated with an already-governed asset — or a defined portion of those
rights — from a specified current holder to a specified recipient, under
defined governance conditions.**

This package contains the request, the mandate that authorizes it, the evidence
of the movement an external system reported effecting, and the evidence of what
that system later reported became of it. It is a pure data contract: no
persistence, no service, no API, no policy engine, no provider SDK, no
execution.

## What Frontera Systems governs, and what it does not

Soberanía governs **the authority to transfer**. It does not transfer.

Nothing here moves a right, updates a registry, acts as a transfer agent or
custodian, passes title, drafts or signs an agreement, prices a transfer, holds
or releases consideration, escrows, settles, or calculates tax. There is
deliberately **no monetary amount anywhere in this package** — where an
arrangement depends on consideration, the authorization requires that *evidence
of it be reported*, and the evidence is an opaque reference Soberanía records and
never interprets.

The existence of a mandate is not a claim that anything moved. Until execution
evidence is recorded, Soberanía's position is that it authorized the movement and
does not know whether the movement happened. And even after evidence exists, it
is a report Soberanía preserved, never a fact Soberanía verified.

## The one property no sibling action has: the quantity is conserved

`TOKENIZE`, `COLLATERALIZE` and `LICENSE` all *bound* a quantity. `TRANSFER`
*moves* one. This single difference drives most of what is distinctive here:

- **`scope` is required.** Moving a right is inherently a question of how much
  of it moves, and there is no third option between "all of it" and "some
  stated portion". `10000` basis points genuinely means "the whole", and
  stating it is a claim the transferor makes rather than a coercion this
  contract imposed — which is exactly why `LICENSE` could not be made to state
  it.
- **Transferred scope accumulates.** Two movements of 15% under a 25%
  authorization move 30% of rights only 25% of which were authorized to move.
  The second is refused even though 15% is, on its own, inside 25%.
- **`partialTransferAllowed` answers two questions at once.** For `LICENSE` and
  `COLLATERALIZE`, "may this be exercised again?" and "may this be exercised
  for less than the whole?" are separate questions with separate flags. For a
  transfer they collapse, because the quantity is conserved: permitting
  tranches *is* permitting repeat execution.
- **A smaller movement is refused when partiality is prohibited.** A licence
  for at most ten seats is honoured by granting five. A transfer of 25% that
  moves 10% has not partially satisfied the authorization — it has performed
  the partial transfer that was prohibited, and left 15% in a state no one
  authorized.

## Five roles, none of them interchangeable

```
requestedBy      who asks                   (on the request/mandate)
asset            what the rights belong to  (an already-governed ResourceRef)
transferorRef    who currently holds them   (the right leaves this party)
transfereeRef    who receives them          (the right arrives at this party)
executorRef?     who may effect it          (a registry/custodian/agent)
```

**`transferorRef` is not the requester**, and this is new. No sibling action
names the party an authorization takes something *away* from, because none of
them takes anything away. A delegated administrator, a corporate secretary or a
managing agent routinely submits a transfer of a right held by the entity it
acts for. The request records whose right is moving; the Kernel decides whether
the requester had authority to move it. Equating the two would silently convert
"who asked" into "whose property this was".

**`transfereeRef` is absolutely binding.** Unlike
`EnterpriseLicenseTerms.licenseeRef`, no disposition relaxes it. A licence has
an assignment disposition because a licensee may later pass on a permission it
holds. A transfer has no equivalent: a "substituted recipient" is not a
relaxation of anything, it is a different transfer to a different party
requiring its own authority, policy and approvals.

**`executorRef` is optional**, confirming the `LICENSE` finding for a sharper
reason: the *same* action has an external performer in some arrangements and
not in others. A holder moving a right directly performs the act itself; a
movement effected through a registry, custodian or transfer agent has a
distinct performer whose identity should be bound. Binding the transferee as
executor of its own acquisition is rejected at validation — it would make the
binding vacuous.

## Actions this package deliberately does not introduce

`REVERSE_TRANSFER`, `RESCIND_TRANSFER` and `RETURN` are recorded in
`ENTERPRISE_ACTIONS_DISTINCT_FROM_TRANSFER` as different actions, and none is
implemented.

A reported reversal is recorded as **lifecycle evidence** — an observation,
never a governed act. And it **restores nothing**: recording one does not
decrement the mandate's transferred scope or execution count, because Soberanía
cannot verify the reversal and must not manufacture fresh transfer capacity
over a right already recorded as having left. Should reversing a transfer ever
need to be *authorized* rather than *observed*, it would be a transfer in its
own right — rights moving back — rather than an undo button on this one.

## Revocation is not reversal

Revoking a mandate withdraws the authority to move *further* rights from that
moment. It does not undo, unwind or rescind a movement already effected — Soberanía
cannot pull back a right it never held and did not move. The revocation record
preserves both the execution count and the cumulative transferred scope at the
moment authority was withdrawn, so the record shows precisely what revocation
did *not* undo.

## Transferability is never assumed

No governed right is marked transferable or non-transferable anywhere in this
package. Whether a usage right may be assigned, whether an ownership interest
may be split, and whether a contractual claim is capable of novation are
matters of the arrangement and the jurisdiction. Soberanía evaluates configured
authority, policy, approvals and obligations, and encodes no universal legal
rule.

## Recording a transfer does not move authority

This is the most important boundary this action has, and it is a measured
finding rather than a design intention: after a fully-evidenced transfer, the
recipient holds no authority inside Soberanía, and the transferor's authority is
unchanged. Nothing in this package or its runtime writes to the Authority
Graph. See `docs/architecture/ADR-TRANSFER-ACTION.md`, "Post-transfer
authority", and the suite
`src/enterprise/__tests__/transfer-authority-transition.test.ts`, which
measures it.

## Related

- `docs/enterprise/AOC_TRANSFER_ACTION.md` — the canonical action documentation.
- `docs/architecture/ADR-TRANSFER-ACTION.md` — the decision record.
- `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md` — the
  four-enforcement audit.
- `@aoc-enterprise/governed-authorization` — the action-neutral vocabulary this
  package consumes.

Ownership: Frontera Systems.
