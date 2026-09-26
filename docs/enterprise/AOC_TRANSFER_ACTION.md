# Frontera Systems — the `TRANSFER` Governed Action

## Where this sits

```
Soberanía Protocol
  └─ Sovereignty Capabilities

Frontera Systems
  └─ Governed Actions          TOKENIZE · COLLATERALIZE · LICENSE · TRANSFER
       └─ Enforcement          the evaluation of whether, and how, one may happen
            └─ Grants / Mandates   the durable artifact a successful evaluation produces
                 └─ Evidence        what an external system reported afterwards
```

`TRANSFER` is an **Frontera Systems Governed Action**. It is *not* a Soberanía
Protocol Sovereignty Capability. The Kernel's internal field is still named
`capability`, and `capability: 'transfer'` should be read as "the identifier of
the Governed Action `TRANSFER`"; no repository-wide rename is implied.

Three terms, kept apart throughout:

```
TRANSFER                 the Governed Action
Transfer Enforcement     Frontera Systems' evaluation of whether/how it may happen
TransferMandate          the durable, Soberanía-owned authorization artifact it produces
```

## What TRANSFER means

> Authorize the movement of specified governed rights associated with an
> already-governed asset — or a defined portion of those rights — from a
> specified current holder to a specified recipient, under defined governance
> conditions.

Soberanía governs **the authority to transfer**. It does not perform the transfer.

## TRANSFER is about rights, not objects

The model is never "move Asset A from Alice to Bob". It is:

```
Asset A
   ↓
Right R                       (one of five governed-right categories)
   ↓
a defined portion of R        (25%, or 10 named units)
   ↓
moves from Holder A to Recipient B
```

A transfer names the rights it moves. `terms.rights` may not be empty, and
"transfer the asset" is not an expressible authorization.

## How TRANSFER differs from its siblings

```
PROTOCOLIZE     establishes governed identity / authority / evidence context
TOKENIZE        authorizes an external representation of rights
COLLATERALIZE   authorizes rights to be committed as security
LICENSE         authorizes permission to exercise rights
TRANSFER        authorizes the movement of a right, or a portion of it
```

- **`TRANSFER != LICENSE`.** A licence permits a licensee to *use* rights the
  licensor keeps. After a licence, the licensor still holds what it licensed;
  after a transfer, it does not.
- **`TRANSFER != COLLATERALIZE`.** An encumbrance leaves the right where it is.
  An encumbered right is still the holder's.
- **`TRANSFER != TOKENIZE`.** A representation changes nothing about which
  party holds the right.
- **`TRANSFER != ACCESS`.** Access is permission to reach a resource now;
  transfer reassigns a right for the future.

## The canonical governance flow

Nothing here bypasses the Kernel, and nothing here is a new decision engine.

```
Governed Asset
      ↓
TRANSFER request                  (validated against the canonical contract)
      ↓
AocKernel.evaluate                Recognition → Authority Graph → policy →
      ↓                           Approval Runtime → obligations
decision persisted                one integrity-chained Governance Store aggregate
      ↓
result.status === 'allowed'?      approval_required produces NO mandate
      ↓
TransferMandate issued
      ↓
TransferMandate persisted         durable, tenant-scoped, digest-protected
      ↓
authorization_artifact            appended as a Governance Store reference
      ↓
Reference Integrity               sequence · integrity version · chain link · digest,
                                  all computed inside the Store's own transaction
      ↓
external transfer execution       by a registry, custodian, agent, or the holder
      ↓
execution_record                  the movement, as reported
      ↓
Reference Integrity
      ↓
execution_record                  optional: what the system later reported became of it
```

**The mandate issuance invariant.** A decision is persisted before any mandate
can exist; a mandate is issued only for `allowed`; the mandate is persisted
before the artifact reference is appended; and the reference's chain position
and digest are computed by the Store, not by this action. No authority is ever
inferred from a reference — a reference type is evidence classification, never
authority.

## The conserved quantity

This is what makes `TRANSFER` structurally different from its three siblings.
They all *bound* a quantity; `TRANSFER` *moves* one.

```
                required scope?   accumulates?   partial + repeat
TOKENIZE        yes               no             separate concerns
COLLATERALIZE   yes               yes            separate concerns
LICENSE         no                no             separate concerns
TRANSFER        yes               yes            ONE concern
```

- **`scope` is required.** A transfer that declines to say how much moves is
  ambiguous about the only thing distinguishing a full transfer from a partial
  one. `10000` basis points genuinely means "the whole".
- **Transferred scope accumulates.** 10% + 15% under a 25% authorization
  exhausts it; a further 1% is refused, because what has left cannot leave
  again.
- **`partialTransferAllowed` decides both partiality and repetition**, because
  for a conserved quantity those are the same question. `false` means "one
  movement, of exactly the authorized portion" — a *smaller* movement is
  refused too, which is the asymmetry with a licence's unit ceiling.

Quantities are integers throughout — basis points or named units — never
floating-point percentages, and incommensurable quantities (a unit count
against a proportional share, or two different denominations) are refused
rather than coerced.

## Roles

```
requestedBy      who asks                   an authorized administrator, often not the holder
transferorRef    who currently holds        the right leaves this party
transfereeRef    who receives               binding without exception
executorRef?     who may effect it          optional — bound only when one exists
approver         who approved               Approval Runtime, when policy required it
```

`requestedBy` and `transferorRef` are deliberately distinct and are surfaced
side by side in the evidence lineage so a reviewer can see when they differ.

## Recipient acceptance, and consideration

Neither is hard-coded, and neither is a workflow Soberanía runs.

**Acceptance** is expressible two ways, both already existing:
`constraints.recipientAcceptanceRequired` makes it an evidence requirement
checked at execution against a reported acceptance reference; or a deployment
makes it a *governed* prerequisite through the Approval Runtime, which already
models exactly that. Whether a transfer needs acceptance at all is
arrangement-specific — a registered book-entry movement typically does not, a
novated contractual claim typically does — so Soberanía neither requires it
universally nor performs it.

**Consideration** is the whole of Soberanía's involvement with money here:
`constraints.considerationEvidenceRequired` requires that a reference be
reported. Soberanía computes no price, holds no funds, escrows nothing, settles
nothing, converts nothing, and there is deliberately no amount field anywhere
in this action.

## What a TransferMandate authorizes, and what it does not say

A mandate means: *Soberanía authorized this movement, under these conditions.*

It does **not** mean the movement happened, that title passed, that any
registry reflects it, that consideration was paid, that any formality was
satisfied, or that the transferor genuinely held what it purported to move.

```
TransferMandate           ≠   executed transfer
mandate revocation        ≠   transfer reversal
execution evidence        ≠   universal legal title
Enterprise state          ≠   sovereign ownership state
reference integrity       ≠   authority
```

## Revocation is not reversal

Revoking withdraws the authority to move *further* rights. It does not undo a
movement already effected — Soberanía cannot pull back a right it never held. The
revocation record preserves both the execution count and the cumulative
transferred scope at the moment authority was withdrawn, so the record shows
precisely what revocation did not undo. Evidence recorded before revocation is
preserved immutably.

Symmetrically, an external system *reporting* a registration, rejection,
reversal or correction is an observation, not a governance act. It is recorded
as lifecycle evidence and changes neither the mandate's status, nor its
execution count, nor its transferred scope. **A reported reversal restores no
transfer capacity** — decrementing on an unverified report would manufacture
fresh capacity over a right Soberanía has already recorded as having left.

## What Soberanía believes about the recipient afterwards

**Nothing.**

This is the single most important operational fact about this action, and it is
a measurement rather than a design statement — see
`src/enterprise/__tests__/transfer-authority-transition.test.ts`:

- After a fully-evidenced transfer of 25% of an economic interest to Party B,
  a governed request submitted **by Party B** over that right is **denied**.
  Party B is not an actor the Authority Graph knows.
- The **transferor's authority is unchanged**. A second `TRANSFER` request for
  the same 25% is still `allowed` at the governance layer; only the
  per-mandate conservation rule stops the same portion moving twice, and that
  rule is scoped to one mandate.
- The evidence lineage deliberately exposes no `currentHolder`. Soberanía never
  verified the movement and holds no ownership state to update.

What *does* make Soberanía recognize a recipient is an explicit administrative act —
registering the actor, issuing a passport, a capability token, and an authority
grant. **No transfer code path performs any of it**, and adding one would be an
action-specific mutation of the Authority Graph, which is precisely the hack
this implementation refuses.

This is recorded as an architectural gap, not a defect of this action. See
`docs/architecture/ADR-TRANSFER-ACTION.md`.

## Persistence

The TransferMandate Store is an independent store, in-memory and SQLite from
day one, held to identical semantics by a shared behavioural contract suite.

Durable invariants pushed into the database:

```
request_ref UNIQUE            one request authorizes at most one mandate
execution_id PRIMARY KEY      one movement is recorded at most once
mandate_id UNIQUE (revocation) at most one revocation per mandate
(mandate_id, sequence) UNIQUE restart-stable append order on both evidence tables
execution_id FOREIGN KEY      a lifecycle report references a movement Soberanía has evidence of
```

Terms are stored canonically with a digest recomputed on every read, so a scope
widening, a transferor or recipient substitution, an executor swap or a
constraint relaxation applied after commit fails closed rather than
reconstructing an authorization that no longer says what was authorized. This
is integrity detection, not a signature; the Governance Store's documented
digest limits apply.

Unlike the licence store, this schema carries a cumulative
`transferred_scope_json` column — matching collateral, for a stronger reason.

## Boundary

Frontera Systems is not a registry, a transfer agent, a custodian, a settlement
system, an escrow, a title system, or a marketplace. There is no provider
adapter for transfer and none is implied.

## Related

- `docs/architecture/ADR-TRANSFER-ACTION.md`
- `docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`
- `docs/enterprise/AOC_LICENSE_ACTION.md`
- `docs/enterprise/AOC_COLLATERALIZE_ACTION.md`
- `packages/transfer-mandate/README.md`
- `packages/governed-authorization/README.md`

## Update — constraint applicability

`TRANSFER` is the only current governed action classified as
**structurally constraint-aware**, and the distinction is load-bearing.

```
reservation behaviour            required (it debits a position)
produces persistent constraint   none
consumes constraint class        none
structural effect                YES — the transferor's remaining authority must
                                 still cover every persistent constraint attached
                                 to that holder
policy visibility                full
release relationship             none
```

With a holder at 5 000 bp and a 4 000 bp collateral constraint standing, a
transfer is bounded at 1 000. **That is not the rule "collateralized authority
may not be sold."** Soberanía asserts no such rule: 1 000 moves freely, and the bound
exists only because constraints are holder-bound and do not follow the authority
to a recipient, so Soberanía would otherwise be left holding a constraint over
authority its holder no longer possesses.

`TRANSFER` deliberately does **not** consume the collateral capacity class, even
though doing so would reproduce the same number today. Transferring is not
committing collateral, and the two come apart for the first future class a
transfer should not consume.

A deployment that *does* want a commercial rule — "no transfer while collateral
stands" — expresses it as policy, which sees the typed constraint facts and may
narrow. It can never widen: a movement that would strand a constraint is refused
whatever any policy concludes. See
`AOC_GOVERNED_CONSTRAINT_APPLICABILITY.md`.
