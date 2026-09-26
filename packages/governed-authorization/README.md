# `@aoc-enterprise/governed-authorization`

The action-neutral vocabulary shared by Frontera Systems' governed actions.

This package exists because four independently-motivated governed actions —
`TOKENIZE`, `COLLATERALIZE`, `LICENSE` and `TRANSFER` — converged on the same
small set of concepts, with the same meanings, without any of them being
written with extraction in mind. It contains only what survived that
four-way test.

It is **pure data vocabulary**. There is no orchestration, no policy engine, no
persistence, no service, no API, no provider adapter, and no execution here.
There is also, deliberately, no validation: each action keeps its own
validators, its own error taxonomy and its own serializers, because the
*domain* constraints genuinely differ even where the *shapes* do not.

## What is here

| Export | What it is |
| --- | --- |
| `GovernedRightType`, `GOVERNED_RIGHT_TYPES`, `isGovernedRightType` | The five governed-right categories, as a closed union. |
| `GovernedRightsScope` + `Equals` / `Within` / `Sum` / `serialize` | An exact quantity over a right — proportional basis points or named units. |
| `GovernedAuthorizationStatus` | The two-state authorization lifecycle, `active \| revoked`. |
| `GovernedAuthorizationArtifact<TTerms>` | The seventeen-field skeleton of a durable authorization artifact. |
| `GovernedExecutionEvidenceCore` | The nine-field core of a report that an external system acted. |
| `GovernedLifecycleEvidenceCore` | The eight-field core of a report about what became of such an act. |

## What is deliberately not here, and why

The audit that authorized this package
(`docs/architecture/ADR-ENTERPRISE-ENFORCEMENT-VOCABULARY.md`) rejected more
candidates than it accepted. The rejections are the more useful half.

**Action terms.** Tokenization, collateralization, licence and transfer terms
share no field beyond `rights`. `TTerms` is a type parameter, not a member. A
unified terms type would have almost every field optional, which is how a
contract stops constraining anything.

**Requiredness and accumulation for a scope.** Four actions produced a
byte-identical scope *type* and four different policies over it:

```
                required?   accumulates?
TOKENIZE        yes         no      (an issuance ceiling)
COLLATERALIZE   yes         yes     (encumbering a finite right exhausts it)
LICENSE         NO          no      ("display for 12 months" has no fraction)
TRANSFER        yes         yes     (what has left cannot leave again)
```

A mandatory generic scope would corrupt `LICENSE`; an accumulating one would
corrupt `TOKENIZE` and `LICENSE`. So the value type is shared and the policy
stays local.

**Party roles.** Four actions produced `executorRef`, `securedPartyRef`,
`licenseeRef`, `transferorRef` and `transfereeRef`. They share identity
representation and nothing else — they differ in what substituting them
*means*, in whether they are optional, and in what may relax them. A licensee
is not an executor, a secured party is not an executor, and a transferee is not
a licensee.

**The actor on execution evidence.** This is the sharpest instance of the
above, and the reason `GovernedExecutionEvidenceCore` has nine fields rather
than ten. `TOKENIZE` and `COLLATERALIZE` carry a required, always-checked
`executorRef`; `LICENSE` and `TRANSFER` carry an `executedBy` that is an
observation unless a binding exists. One field would have had to mean "checked"
and "merely recorded" at once.

**Any notion of what a right permits.** No value in `GovernedRightType` is
marked transferable, licensable, encumberable or tokenizable. Those are matters
of the arrangement and the jurisdiction, evaluated by configured authority,
policy, approvals and obligations — never encoded as universal law in a
vocabulary.

## What a `GovernedRightType` actually is

Not "a right an action grants". It is **a category of right attached to a
governed asset**, which four different exercises of authority each select from:
representing it externally, encumbering it, permitting its exercise, and moving
it.

`TRANSFER` is what settled this. For `LICENSE`, `'ownership-interest'` names
the right a permission *draws on* while the permission granted is something
narrower. For `TRANSFER`, the very same value names the thing that *moves*. One
vocabulary, two completely different relations to it — which is only possible
because the vocabulary is asset-side rather than action-side.

## What this vocabulary is not connected to

**Authority.** The Authority Graph scopes authority by capability, action and
resource-scope *string*, and holds no governed-right field of any kind. A value
from `GovernedRightType` is action payload that policy may read; it is never,
by itself, a statement that anyone holds anything, and no authority check
consults it. See `docs/architecture/ADR-TRANSFER-ACTION.md`,
"Authority-source right vs action-target right".

## Compatibility

Every consuming action aliases or extends these types rather than replacing its
own. `EnterpriseLicensableRightType` is still exported by
`@aoc-enterprise/license-mandate`; `EnterpriseTransferScope` is still exported
by `@aoc-enterprise/transfer-mandate`; every mandate still declares its own
`schemaVersion` literal so a serialized artifact names its schema on its face
and cannot be replayed through a sibling action's contract. No serialized byte,
no consumer, no validator and no stored record changed when this package was
introduced.

Ownership: Frontera Systems.
