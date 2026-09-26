# ADR: The four-enforcement semantic audit — what vocabulary genuinely belongs to Frontera Systems

- Status: accepted. **Supersedes the three-enforcement audit** recorded in this
  file at commit `91460d3`; that audit's conclusions are preserved below, each
  marked **confirmed**, **refined** or **refuted** by the fourth enforcement.
- Related: `docs/architecture/ADR-TOKENIZE-CAPABILITY.md`,
  `docs/architecture/ADR-COLLATERALIZE-ACTION.md`,
  `docs/architecture/ADR-LICENSE-ACTION.md`,
  `docs/architecture/ADR-TRANSFER-ACTION.md`
- Scope: `@aoc-enterprise/{tokenization,collateralization,license,transfer}-mandate`,
  `@aoc-enterprise/governed-authorization`,
  `src/enterprise/{tokenization,collateralization,license,transfer}-governance/`

## Context

Frontera Systems now governs four concrete exercises of authority over a governed
asset:

```
TOKENIZE       → authorize an external representation of governed rights
COLLATERALIZE  → authorize governed rights to be committed as security
LICENSE        → authorize permission to exercise governed rights
TRANSFER       → authorize the movement of a governed right to another holder
```

The three-enforcement audit found several primitives semantically identical and
deferred every one of them, on a single stated ground: extraction would require
a new dependency edge into already-frozen contract packages, for a benefit that
is declarative rather than behavioural. It recorded a trigger — *"It should be
done when a fourth enforcement lands, or when one of these packages needs a
breaking version for an unrelated reason — whichever comes first."*

The fourth enforcement has landed. This ADR re-runs the audit against the
actual source with four data points, and — for the first time — acts on it.

## Method

Each concern was compared across four contract packages and four governance
runtimes, **mechanically where the comparison was structural**: field lists
were extracted from the source and diffed rather than eyeballed. A concern
counts as **generic** only if its meaning can be stated without naming any of
the four actions, and only if all applicable implementations mean the same
thing by it — not merely spell it the same way.

The audit ran only after `TRANSFER` was independently green.

## The four-enforcement semantic matrix

| Concern | TOKENIZE | COLLATERALIZE | LICENSE | TRANSFER | Conclusion |
| --- | --- | --- | --- | --- | --- |
| Governed asset | `ResourceRef` identity only | same | same | same | **Identical 4/4.** Already a shared Protocol primitive. |
| Action-target right | rights being *represented* | rights being *encumbered* | rights whose exercise is *permitted* | rights being *moved* | **Four different relations to one vocabulary.** |
| Authority-source right | none | none | none | none | **No action expresses one.** Authority is scoped by capability + action + resource-scope string only. |
| Rights vocabulary | 5-value closed union | same 5 | same 5 | same 5 | **Identical 4/4. EXTRACTED.** |
| Proportional scope | `basisPoints`, integer | same | same | same | **Identical 4/4. EXTRACTED** (value type). |
| Unitized scope | `units` + opaque denomination | same | same | same | **Identical 4/4. EXTRACTED** (value type). |
| Scope requiredness | required | required | **optional** | required | **Action-specific 3–1.** |
| Scope accumulation | none | **cumulative** | none | **cumulative** | **Action-specific 2–2**, and it tracks whether the quantity is *consumed*. |
| Action-specific scope | none | none | uses · contexts · exclusivity · term · unit ceilings | none | **Only LICENSE has a second kind of scope.** |
| Requester | `requestedBy` | same | same | same, **and distinct from the holder** | **Identical 4/4** (skeleton field). |
| Source party | none | none | none | **`transferorRef`** | **Unique to TRANSFER.** No sibling takes anything away. |
| Beneficiary / counterparty | none | `securedPartyRef` (benefits) | `licenseeRef` (receives permission) | `transfereeRef` (receives the right) | **Not generic.** Three different relations; one action has none. |
| Recipient substitutability | n/a | n/a | relaxable by `assignment` | **never relaxable** | **Not generic.** |
| Executor | required | required | **optional** | **optional** | **Refuted as universal, twice.** |
| Authority path | Recognition → Authority Graph → Kernel | identical | identical | identical | **Identical 4/4.** Already generic. |
| Approvals | Approval Runtime | identical | identical | identical | **Identical 4/4.** Already generic. |
| Obligations | Enterprise obligations | identical | identical | identical | **Identical 4/4.** Already generic. |
| Mandate common metadata | 17 fields | same 17 | same 17 | same 17, **zero extras in any** | **Identical 4/4. EXTRACTED.** |
| Validity | `effectiveFrom`/`expiresAt`, required | same | same **+ external term ceiling** | same | **Mandate window identical 4/4. EXTRACTED.** |
| Revocation | `active \| revoked`; 10-field record | same + `committedScopeAtRevocation?` | same 10 | same + `transferredScopeAtRevocation?` | **10 fields + status identical 4/4. EXTRACTED.** The extra field appears in exactly the two actions with a conserved quantity. |
| Execution evidence | envelope + issuance payload | envelope + collateral payload | envelope + licence payload | envelope + movement payload | **9-field envelope identical 4/4. EXTRACTED.** Payloads share nothing. |
| Execution actor | `executorRef`, bound | `executorRef`, bound | `executedBy`, observed | `executedBy`, observed | **Not generic, 2–2.** The split is semantic, not cosmetic. |
| Lifecycle evidence | **none** | release / discharge / satisfied / terminated | expired / terminated / cancelled / surrendered / superseded | registered / rejected / reversed / corrected / superseded | **8-field envelope identical 3/3 that have one. EXTRACTED.** Taxonomy action-specific. |
| Durable store | own tables, WAL, digest, version guard | identical conventions | identical conventions | identical conventions | **Conventions identical; schemas domain-specific.** |
| `authorization_artifact` | mandate → reference | identical | identical | identical | **Identical 4/4.** Already generic. |
| Reference integrity | store-sealed | identical | identical | identical | **Identical 4/4.** Already generic. |
| Post-execution authority change | none | none | none | **none — but arguably needed** | **A new distinction, and the architecture supports neither side of it.** |
| Protocol impact | none | none | none | none | **Identical 4/4.** |

## Generic primitive decisions

### Candidate 1 — Governed-right vocabulary

- **TOKENIZE**: `ENTERPRISE_TOKENIZED_RIGHT_TYPES`, 5 values.
- **COLLATERALIZE / LICENSE / TRANSFER**: the same 5 values, three times.
- **Semantic result.** **Identical 4/4**, and `TRANSFER` supplied the argument
  the three-way audit could only assert. The vocabulary describes **types of
  rights attached to an asset (A)**, not **rights granted by each action (B)**,
  and here is the proof: for `LICENSE`, `'ownership-interest'` names the right
  a permission *draws on* while the permission granted is something narrower;
  for `TRANSFER`, the very same value names the thing that *moves*. One
  vocabulary sustaining two completely different relations is only possible if
  it is asset-side.
- **Decision: EXTRACT NOW** → `GovernedRightType`.
- **Compatibility impact.** None. Each action re-exports its own alias
  (`EnterpriseLicensableRightType = GovernedRightType`), so every consumer,
  serialized byte and stored record is unchanged.
- **Three-way conclusion: CONFIRMED and REFINED** (the A-or-B question is now
  answered from evidence rather than inference).

### Candidate 2 — Authority-source right vs action-target right

**A new candidate, raised by the `LICENSE` audit and settled here.**

- **Evidence.** `AuthorityGrant` carries `capability`, `actions[]`,
  `resourceScopes[]` — and no governed-right field. Neither does
  `DelegationGrant`, `RecognitionCapabilityToken`, or any authority policy. The
  governed-right vocabulary appears only inside `action.parameters`.
- **Measured, not asserted** (`transfer-authority-transition.test.ts`):
  authority is asset-scoped by default; a hierarchical resource-scope suffix
  *does* contain when a caller names it; and **the convention is unenforced** —
  an actor scoped to `…:usage-right` successfully transferred the
  **ownership interest**, because nothing connects the scope string to the
  action's target right.
- **Semantic result: SEMANTIC DISTINCTION PROVEN, BUT THE CURRENT AUTHORITY
  MODEL DOES NOT EXPRESS IT.**
- **Decision: KEEP ACTION-SPECIFIC — and record an architecture gap.** No
  `AuthorityBasis`/`ActionTargetRight` types were introduced. Introducing them
  in a contract package while the Authority Graph cannot evaluate them would
  produce a vocabulary that *looks* like a guarantee and is not one.
- **Extraction path.** Right-scoped authority is an Authority Graph change —
  a right dimension on `AuthorityGrant` and a policy that evaluates it against
  `action.parameters` — not a contract-package change. Deliberately not
  attempted here.

### Candidate 3 — `GovernedRightsScope`

- **Evidence.** The value type is byte-identical 4/4. The *policy* over it is
  not:

  ```
                  required?   accumulates?
  TOKENIZE        yes         no
  COLLATERALIZE   yes         yes
  LICENSE         NO          no
  TRANSFER        yes         yes
  ```

- **Semantic result.** The three-way audit's split — type generic, requiredness
  and accumulation action-specific — is **confirmed by a fourth independent
  case, and made sharper**: `TRANSFER` sits *opposite* `LICENSE` on
  requiredness and *with* `COLLATERALIZE` on accumulation, so neither property
  is a majority artefact.
- **Decision: EXTRACT NOW** the value type and its three total functions
  (`Equals`, `Within`, `Sum`) and `serialize`. **KEEP ACTION-SPECIFIC**
  requiredness, accumulation, and presence semantics.
- **Note on presence.** `LICENSE` treats an absent scope as "not fractionally
  expressed" — emphatically not 100% — and refuses to compare it against a
  present one. That refusal stayed in `LICENSE`: it is a statement about
  permissions, not about quantities.
- **Three-way conclusion: CONFIRMED.**

### Candidate 4 — Mandate reference / metadata skeleton

- **Evidence, extracted mechanically from the source:**

  ```
  TOKENIZE       17 fields
  COLLATERALIZE  17 fields
  LICENSE        17 fields
  TRANSFER       17 fields
  common         17          extras in any package: ZERO
  ```

  `schemaVersion · id · status · asset · terms · requestRef · requestedBy ·
  decisionRef · effectiveFrom · expiresAt · correlationId · evaluationRef? ·
  issuerRef? · approvalRefs? · obligationRefs? · evidenceRefs? · auditRefs?`

- **Semantic result. Identical 4/4** — four independently-motivated domains,
  written months apart, produced the same seventeen fields with the same
  meanings, the same optionality, and the same "reference what is owned
  elsewhere, never embed it" discipline, with **no action adding a single field
  of its own**. It is definable without naming any action: *the identity of a
  durable authorization artifact, its linkage to the governance decision that
  produced it, its validity window, and its revocation state.*
- **Decision: EXTRACT NOW** → `GovernedAuthorizationArtifact<TTerms>`.
- **Compatibility impact.** None. Each mandate `extends` the base and
  re-declares `schemaVersion` as its own literal and `status` as its own union,
  so a serialized artifact still names its schema on its face and still cannot
  be replayed through a sibling action's contract. Each action keeps its own
  validator, its own ~24-code error union and its own serializer.
- **Three-way conclusion: CONFIRMED, and the deferral is now LIFTED** — see
  "Why extraction happened this time".

### Candidate 5 — `GovernedAuthorizationArtifact<TTerms>` as a migration path

The three-way audit named this exact shape as the migration path it would take
when a fourth enforcement landed. **Taken, under that name.** `UniversalMandate`
remains **REJECTED**: a single mandate type would either erase the domain
distinctions or become a union every consumer must narrow.

### Candidate 6 — Validity / revocation metadata

- **Evidence.** `active | revoked` in all four, with the same recorded
  rationale for refusing a third state. `effectiveFrom`/`expiresAt` required in
  all four. Revocation records share **10 identical fields** 4/4.
- **The one variation is informative rather than awkward.** The extra field —
  `committedScopeAtRevocation?` / `transferredScopeAtRevocation?` — appears in
  exactly the two actions whose quantity is *consumed*, and in neither of the
  two whose quantity is a ceiling. It correlates perfectly with Candidate 3's
  accumulation split.
- **Decision: EXTRACT NOW** → `GovernedAuthorizationStatus`, folded into
  Candidate 4 rather than extracted separately. **KEEP ACTION-SPECIFIC** the
  revocation *record* (it is a runtime row shape, not contract vocabulary) and
  `LICENSE`'s external-term ceiling, which is a genuinely different duration.
- **Three-way conclusion: CONFIRMED.**

### Candidate 7 — External execution evidence envelope

- **Evidence, extracted mechanically.** Nine fields common to all four:
  `schemaVersion · id · mandateRef · executedAt · rights · correlationId ·
  externalSystem? · externalTransactionReference? · evidenceRefs?`, plus the
  identical observation-only posture.
- **Refinement of the three-way result:** the proven envelope is **nine fields,
  not seven**. `rights` is common to all four, which three actions could not
  establish on their own.
- **And a new negative result: the actor is not in the envelope**, and the
  split is semantic:

  ```
  TOKENIZE       executorRef   BOUND — checked, always
  COLLATERALIZE  executorRef   BOUND — checked, always
  LICENSE        executedBy    OBSERVED — checked only if one was bound
  TRANSFER       executedBy    OBSERVED — checked only if one was bound
  ```

  One inherited field would have had to mean "checked" and "merely recorded" at
  once.
- **Decision: EXTRACT NOW** → `GovernedExecutionEvidenceCore` (9 fields).
  **KEEP ACTION-SPECIFIC** the actor field and every payload.
- **Three-way conclusion: CONFIRMED and REFINED** (envelope widened 7 → 9;
  actor explicitly excluded).

### Candidate 8 — Lifecycle evidence

- **The three-way audit's explicit open question, and the reason it said
  `NEEDS FOURTH ENFORCEMENT`. `TRANSFER` supplied the fourth case.**
- **Evidence.** Three of four have one; the eight structural fields are
  identical across all three. `LICENSE` and `TRANSFER` additionally agree
  field-for-field (11/11) on `occurredAt` / `lifecycleType` /
  `externalReference?`; `COLLATERALIZE` spells the same three concepts
  `releasedAt` / `releaseType` / `externalReleaseReference`.
- **And the posture is identical in all three, in three respects that matter
  more than the fields:** append-only against a *specific* execution; never a
  mandate status; and **never restores capacity**. `TRANSFER` holds this last
  rule hardest — a reported reversal decrements nothing.
- **Why TOKENIZE has none is now explicable rather than merely observed.**
  Minting produces a token whose own subsequent life — burned, moved, split —
  would be a governed act *over the token*, not a report about the minting. The
  other three each leave a standing external arrangement that the same
  arrangement can later be reported to have exited.
- **Semantic result: generic envelope proven; event taxonomy action-specific.**
  The taxonomies share not one value across the three.
- **Decision: EXTRACT NOW** → `GovernedLifecycleEvidenceCore` (8 fields).
  **KEEP ACTION-SPECIFIC** the taxonomies and the instant/category field names.
  `COLLATERALIZE`'s naming divergence is recorded as naming rather than
  meaning; a frozen field was **not** renamed to tidy it.
- **Three-way conclusion: RESOLVED** (from `NEEDS FOURTH ENFORCEMENT`).

### Candidate 9 — Party roles

- **Evidence, now five roles across four actions:**

  ```
  executorRef      may PERFORM the external act     TOKENIZE, COLLATERALIZE (required)
                                                    LICENSE, TRANSFER (optional)
  securedPartyRef  BENEFITS from the arrangement    COLLATERALIZE
  licenseeRef      RECEIVES the permission          LICENSE (relaxable by assignment)
  transferorRef    LOSES the right                  TRANSFER
  transfereeRef    RECEIVES the right               TRANSFER (never relaxable)
  ```

- **Semantic result: NOT GENERIC**, and the fourth action strengthened the
  refutation twice. It added the first role that *loses* something, and it
  added a recipient that — unlike a licensee — can never be substituted. Two
  "recipients" that differ in whether substitution is even representable are
  not one concept.
- **Decision: KEEP ACTION-SPECIFIC.** The identity *primitive* (`CanonicalId`)
  is already generic; the role semantics are not. A unifying type would be a
  bag of `CanonicalId`s with a comment.
- **Three-way conclusion: CONFIRMED** (`AuthorizedExecutor` as a universal
  primitive remains **REJECTED AS FALSE ABSTRACTION**, now falsified twice
  independently).

### Candidate 10 — Post-execution state transition

**A new candidate, and the most interesting thing `TRANSFER` found.**

- **Evidence.**

  ```
  TOKENIZE       ownership unchanged
  COLLATERALIZE  ownership unchanged
  LICENSE        ownership unchanged
  TRANSFER       ownership arguably changed — and Soberanía does not know it
  ```

- **Measured** (`transfer-authority-transition.test.ts`): after a complete,
  integrity-sealed, restart-surviving transfer, the recipient's governed
  request is **denied** and the transferor's authority is **unchanged**.
- **Semantic result: a real distinction between non-authority-mutating and
  authority-mutating actions exists — and the architecture currently supports
  only the first kind.**
- **Decision: KEEP ACTION-SPECIFIC — do not implement the taxonomy.** Marking
  actions as authority-mutating would be a label without a mechanism: there is
  no generic authority-transition primitive for such a label to select. What is
  needed is the mechanism, not the taxonomy.
- **Recorded as: AUTHORITY-TRANSITION GAP IDENTIFIED.** See
  `docs/architecture/ADR-TRANSFER-ACTION.md`.
- **Resolution: the mechanism was built; the taxonomy still was not.** A
  generic authority-transition primitive now exists
  (`@aoc-enterprise/governed-authority`,
  `src/enterprise/authority-governance/`), and `TRANSFER` records one on
  accepted execution evidence. The decision above is unchanged and was
  vindicated: no action is *marked* authority-mutating anywhere. An action that
  moves authority calls the primitive, one that does not simply never calls it,
  and `basis.capability` names whichever action produced the evidence — so no
  registry, plugin table or per-action dispatch was needed to select behaviour.
  See `docs/architecture/ADR-GOVERNED-AUTHORITY-TRANSITION.md`.

### Candidate 11 — Tenant scoping and strict-UTC helpers (runtime layer)

- **Evidence.** `canAccess*Organization`, `require*TenantScope`,
  `require*AccessToOrganization` and the strict-UTC predicate are byte-identical
  across all four governance runtimes, differing only in which typed error they
  throw.
- **Decision: KEEP ACTION-SPECIFIC (still).** These are *utilities*, not
  governance vocabulary. A UTC regex has no domain content, and a shared version
  would need an injected error factory to preserve each module's typed error
  taxonomy — trading duplication for indirection exactly where fail-closed
  behaviour must stay obvious.
- **Three-way conclusion: CONFIRMED.**

## Extractions actually performed

**One package: `@aoc-enterprise/governed-authorization`.**

```
GovernedRightType · GOVERNED_RIGHT_TYPES · isGovernedRightType
GovernedRightsScope · Equals / Within / Sum / serialize · FULL_BASIS_POINTS
GovernedAuthorizationStatus
GovernedAuthorizationArtifact<TTerms>
GovernedExecutionEvidenceCore
GovernedLifecycleEvidenceCore
```

Pure data. No orchestration, no policy engine, no persistence, no service, no
API, no provider adapter, no validation, no error taxonomy, no action terms, no
party roles.

All four contract packages consume it. Each keeps its own names as aliases, its
own `schemaVersion` literal, its own validators, its own error unions and its
own serializers.

### Why extraction happened this time

The three-way audit deferred on **one** ground — rubric criterion 5, frozen
contract compatibility — and named the fourth enforcement as the trigger to
revisit. Both halves were tested rather than assumed:

1. **The evidence got stronger, in a way three actions could not produce.** 17
   of 17 mandate fields with zero extras across four independent domains; a
   scope split that is 3–1 on requiredness and 2–2 on accumulation, so neither
   is a majority artefact; and the one open question (lifecycle evidence)
   answered.
2. **The compatibility objection was measured and did not hold.**
   `check-api-freeze` guards the v1 **HTTP** surface, not these packages. None
   of the four is on the published `@aoc-enterprise/runtime` surface — all four
   governance runtimes are deliberately un-barrelled for exactly that reason —
   so `validate:publishability` is unaffected. And structural aliasing changes
   no serialized byte, no stored record, no consumer and no validator.

Every regression suite and every release check was re-run after the extraction:
root **3906 pass / 0 fail**, workspaces **996 pass / 0 fail**, and every check
that passed at baseline still passes.

## Does Frontera Systems need a generic enforcement framework?

**No — and after four implementations it is clearer why it never will.**

The behavioural machinery is already generalized, and all four actions consume
it unchanged:

```
AocKernel               authority · policy · approvals · obligations · decision
Recognition Runtime     standing
Authority Graph         authority, scoped to capability + action + resource string
Approval Runtime        quorum, delegation, segregation of duties
Governance Store        aggregates · references · integrity chain
Reference Integrity     store-computed sealing
persistence conventions WAL · digests · version guards · tenant scoping
```

`TRANSFER` needed no new machinery. It needed a fourth *vocabulary*, and it
found that the vocabulary was already there — which is what this ADR acted on.
An `EnterpriseEnforcementFramework`, `GenericMandateEngine`,
`UniversalGovernedActionEngine` or `ActionPluginFramework` would sit between the
Kernel and four thin domain modules and mediate nothing: the orchestration each
service performs is ~40 lines of sequencing whose every branch is a domain
decision.

**The remaining question was never orchestration. It was vocabulary — and the
vocabulary that survived four domains has now been extracted, and is smaller
than any single implementation would have suggested.**

## Did `TRANSFER` expose missing shared machinery?

**Yes — one thing, and it is not a framework.**

There is **no authority-transition primitive**. The Authority Graph is mutated
only by explicit administrative acts, and nothing expresses "authority over X
moved from A to B" as a first-class, evidenced, revocable operation. Every
sibling action was able to ignore this because none of them changes who may act
next. `TRANSFER` cannot ignore it, and does not pretend to: it records what it
knows and stops.

This was deliberately **not** solved with an action-specific write into the
Authority Graph.

## Did `TRANSFER` expose a need for a Protocol change?

**No.** `@aoc/protocol` holds no owner, holder, controller or
sovereign-ownership record anywhere — `ResourceRef` is `{kind, id, tenantId?,
attributes?}`, pure identity — so a completed transfer has nothing at the
Protocol layer to update. The gap identified above is Enterprise-local: the
state that would need to change is the Authority Graph, an Enterprise feature.

**Classification: `PROTOCOL CHANGE NOT YET REQUIRED, BUT AUTHORITY-TRANSITION
GAP IDENTIFIED`.** It would become a Protocol question only if authority
transitions had to be recognized across independently-governed deployments —
which `TRANSFER` did not demonstrate, and which must not be implemented
speculatively.

## What the fourth enforcement proved about Enterprise

```
                       GOVERNED RIGHT
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
    TOKENIZE            COLLATERALIZE          LICENSE
 representation          encumbrance           permission
        │                    │                    │
        └────────────────────┼────────────────────┘
                             │
                         TRANSFER
                     change of holder
                             │
                             ▼
                        Enforcement          ← identical machinery, 4/4
                             │
                             ▼
                          Mandate            ← identical envelope (now shared),
                             │                 different terms
                             ▼
                  authorization_artifact     ← identical, 4/4
                             │
                             ▼
                    Reference Integrity      ← identical, 4/4
                             │
                             ▼
                     External Execution      ← nothing in common
                             │
                             ▼
                         Evidence            ← identical envelope (now shared),
                             │                 different payloads
                             ▼
                    Authority Transition     ← ✗ DOES NOT EXIST
```

The diagram was incomplete, and `TRANSFER` is what showed where. Changing who
holds a right does require an authority transition, and Soberanía has no primitive
for one at any layer. Everything above that final box is now proven and, where
it was vocabulary, shared.

After four enforcements the smallest reusable semantic vocabulary that
genuinely belongs to Frontera Systems is exactly what
`@aoc-enterprise/governed-authorization` now contains:

1. a **governed asset reference** (already Protocol's `ResourceRef`);
2. a **governed-right vocabulary** — which right of the asset is engaged;
3. an **exact quantity** over those rights, with requiredness and accumulation
   left to each action;
4. an **authorization artifact envelope** — identity, decision linkage,
   validity window, revocation state, reference lists;
5. an **execution evidence envelope** and a **lifecycle evidence envelope**.

Everything else — beneficiaries, executors, holders, recipients, uses,
contexts, exclusivity, registries, accumulation policy, lifecycle taxonomies —
belongs to the action. Four independent domains were required to find that out,
and the fourth was required to act on it.
