# Obligation Runtime

Layer **D** of `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.

> **What must happen before this authorized action may be exercised, and did it?**

That is the only question this module answers. It does not authorize anything,
and it cannot be made to: nothing exported from here carries an allow, a deny, a
policy effect or a decision status, and
`tests/obligation-layer-boundaries.test.ts` fails the build if one ever appears.

## The one invariant

**An obligation never changes the meaning of an authorization decision.**

For the same request, authority, context and policy:

```
POLICY   ALLOW this payment
         BUT REQUIRE finance approval before the authority may be exercised
```

Frontera reports, side by side and never folded:

```
authorization decision  = ALLOW
blocking obligation     = not yet discharged
exercise eligibility    = BLOCKED
```

A pending, failed, stale, expired, rejected, conflicted or otherwise
undischargeable blocking obligation is **never** rewritten into `DENY`. The
distinction is what an auditor needs and what
`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 exists to protect: "policy
said no" and "policy said yes, conditionally, and the condition was not met" are
different facts about a request, and a system that reports them identically has
destroyed the more useful one.

The invariant is settled by deletion, not by inspection.
`src/kernel/__tests__/kernel-obligation-lifecycle.test.ts` evaluates one request
five times — with no capability at all, and at four different lifecycle states —
and asserts the authorization half of the result is byte-identical every time.
All an obligation can change is whether the already-authorized action is
currently eligible to proceed.

Structurally, `applyObligationStep` is the only function that touches the result,
and it adds a field: it reads no `status`, no `reasonCodes` and no `summary`, so
there is no code path by which an obligation could narrow a decision even by
accident. Compare `applyContextStep`, which deliberately *does* narrow — layer C
reports facts the deployment declared it would not proceed without, so an
unresolved required fact denies. The two steps sit next to each other in the
pipeline and behave oppositely on purpose.

## The defect this closes

`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` records it as hole 1:

> `require-approval`, `require-mfa`, `record-usage`, `watermark-content`,
> `require-acceptance` are, today, statements that the platform makes and never
> checks.

`PolicyObligationService.collect()` deduplicates matched-rule obligations and
partitions them into `required`/`optional`, and that is the entire runtime
treatment of an obligation. There is no state, no discharge, no record of who
discharged one, no proof, and nothing that consults discharge before anything
proceeds. This module is the missing lifecycle.

## The ADR lifecycle, mapped

`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §1 draws:

```
required ──▶ pending ──▶ discharged ──▶ verified
   │            │             │
   ├──────────▶ waived        └──▶ rejected
   └──────────▶ expired
```

and calls it, in the same paragraph, "six states, one closed set".
`TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §D names six by hand — "`required →
pending → discharged → verified`, plus `waived` and `expired`" — omitting
`rejected`, which the ADR's own diagram draws.

**All seven nodes are implemented and none is collapsed.** `rejected` is not a
synonym for anything: ADR §2 rules that "a discharge that cannot be verified
stays `discharged`", which leaves no state for a discharge an independent party
actively *refuted*. Merging them would erase the difference between "nobody
could confirm it" and "the approver said no".

The two counts are reconciled rather than one being ignored: `required` is the
**declared** state, what Layer B hands to Layer D the moment a policy declares an
obligation and before this layer has observed anything. The six states this layer
itself *manages* are `pending`, `discharged`, `verified`, `rejected`, `waived`
and `expired`. Both documents are then true of the same closed set.

| ADR state | runtime state | terminal | satisfies a blocking obligation | reached by |
| --- | --- | --- | --- | --- |
| `required` | `'required'` | no | **no** | declaration; the initial state |
| `pending` | `'pending'` | no | **no** | a registered source reporting `pending` |
| `discharged` | `'discharged'` | no | **no** | a *self-reporting* source reporting `discharged` |
| `verified` | `'verified'` | yes | yes | an *independent* source reporting `discharged` |
| `rejected` | `'rejected'` | yes | **no** | any registered source reporting `refused`, on a discharged obligation |
| `waived` | `'waived'` | yes | yes | an *independent* source reporting `waived` |
| `expired` | `'expired'` | yes | **no** | the declared discharge window closing with nothing valid inside it |

`discharged` not satisfying is ADR hard invariants 4 and 5, and it is the whole
point of the phase: "the requester says it obtained finance approval" is not
"finance says so".

### Legal transitions

| from | to | reason | drawn in the ADR |
| --- | --- | --- | --- |
| `required` | `pending` | `discharge_reported` | yes |
| `required` | `waived` | `waiver_recorded` | yes |
| `required` | `expired` | `discharge_window_closed` | yes |
| `pending` | `discharged` | `discharge_reported` | yes |
| `pending` | `waived` | `waiver_recorded` | yes |
| `pending` | `expired` | `discharge_window_closed` | **no — see below** |
| `discharged` | `verified` | `discharge_confirmed` | yes |
| `discharged` | `rejected` | `discharge_refused` | yes |

Every pair not in this table is illegal, and illegality is **reported, never
repaired**. A terminal obligation is not reopened, a refusal does not invent a
discharge to refute, and an out-of-order observation does not rewrite history —
the observation is recorded on `ObligationResolution.disregarded` with reason
`illegal_transition` and the obligation is returned exactly as it was.

`transitionObligation` takes **one** step. An earlier draft searched the graph
for a path, which would have let `required → rejected` resolve as `required →
pending → discharged → rejected` — writing a discharge into the history of an
obligation nobody ever reported discharging. The service composes the sequences
explicitly instead, so every step is legal on its own terms and the history is
the lifecycle that was actually walked.

A step *backwards* along the progress chain (`required → pending → discharged →
verified`) is `unchanged`, not `illegal`: that is what makes a re-delivered
discharge idempotent.

### Divergence from the ADR

One, and it is the only one.

**`pending → expired` is not drawn in the ADR diagram.** It is implemented
because ADR §6 rules that "expiry is a state, not a background job … derived
from the clock at read time", and an obligation cannot be made exempt from its
own discharge window merely by having been reported outstanding first. The edge
moves an obligation into a terminal *blocking* state, so it can only ever
withhold exercise, never permit it. Nothing else departs from the ADR.

One consequence of *not* departing further is worth recording: because the ADR
draws `rejected` only from `discharged`, a refusal of an obligation that nobody
ever reported discharging has no edge to travel. It is refused admission, the
obligation stays where it is, and — if it blocks — it keeps blocking. Expressing
"finance was asked and said no, and nobody had claimed otherwise" as its own
state would need an ADR edge that does not exist, so it is deferred rather than
invented.

## Declaration

Operator-provisioned configuration, exactly as `ContextDeclaration` is, and for
the same reason: this phase deliberately leaves the policy-authoring surface
frozen. There is no `REQUIRE` keyword, no expression string and no parser.

```ts
declaration: {
  requirements: [
    { obligationType: 'finance.approval', blocking: true, maxDischargeAgeSeconds: 86_400 },
  ],
}
```

`ObligationType` is a closed union of **two** representative types —
`finance.approval` and `second.signer`. Two, on purpose: the first is the
brief's own worked example and exercises every state, the second exists so that
blocking and non-blocking can be shown on one decision and so nothing in the
implementation can assume there is only ever one obligation. The ADR's wider
list (`require-mfa`, `record-usage`, `watermark-content`, `require-acceptance`)
is deliberately not built here — each is a real integration, and building eight
of them would be building the approval catalogue the ADR spends a section
refusing.

`blocking` is declared explicitly and is never defaulted: "not stated" must
never be read as "not blocking".

## Discharge and the trust boundary

An obligation is discharged only through a trusted, internal path. The request
surface is not an authoritative producer of obligation lifecycle state, and is
not a producer of it at all.

| | |
| --- | --- |
| `ObligationDischargeSource` | a declared, configured, named origin. Operator-provisioned. A request may not introduce one, select which one answers an obligation, or influence its verification class. |
| `ObligationDischargeObservation` | what a source reports: which obligation, which authorization, what happened, when, by whom, under what reference. It has **no** `verificationClass` field and **no** `state` field. |
| `ObligationInstance` | the derived lifecycle state, with its transition history and the discharge it came to rest on. |
| `ObligationResolution` | everything derived for one authorization: instances, the observations that did not count and why, and the aggregate exercise eligibility. |

### Verification class

```
independent    a party structurally independent of the one that benefits — an
               Approval Runtime proof, a provider adapter's acknowledgement, a
               verified attestation. Its report can reach `verified`, and only
               its report can.
self_reported  the acting party, or something it controls. Its report reaches
               `discharged` and stops.
```

Two classes rather than a rank, because the only question a discharge poses is
the binary one. This is `ADR-CONTEXT-PROVENANCE-AND-TRUST.md`'s design principle
one layer over — *the observer says **what** happened and **where** it came from;
trusted configuration decides **how** that source is treated* — applied to a
different axis. It is a separate registry from the context one, not a reuse of
it: a context source answers "what is true" and ranks
`attested`/`authoritative`/`asserted`, and folding the two would force one
vocabulary to carry two unrelated judgments.

Two rules are enforced at wiring time, not review time:

- a source of kind `request` may only be `self_reported`. A deployment able to
  register the requester as independent would have configured away the boundary.
- `independent` requires kind `approval_runtime`, `provider_adapter` or
  `signed_attestation`. A store recording what it was told is not independent of
  whoever told it.

### What a valid discharge must establish

| | how |
| --- | --- |
| which obligation | `obligationType`, matched against the declaration |
| which authorization | `correlation` — `requestId` + `action` + `resourceScope`, all three exact |
| the discharge source | `sourceId`, resolved against the registry; unregistered is discarded |
| the actor | `subjectId`, when the source can say |
| when | `observedAt` |
| whether it is fresh | `observedAt` against the requirement's `maxDischargeAgeSeconds`, at the passed-in instant |
| provenance | `reference` — an approval id, a proof id; opaque here and never dereferenced |
| whether it satisfies | the registry's verification class, through the closed transition table |

An observation failing any of these is reported on
`ObligationResolution.disregarded` with one of six reasons —
`unregistered_source`, `undeclared_obligation`, `correlation_mismatch`,
`stale_observation`, `waiver_not_independent`, `illegal_transition` — so "why is
this still blocked" is answerable from the record rather than by re-running
anything.

### Conflicts

Two *independent* sources contradicting each other — one confirming, one
refusing — marks the obligation `conflicted`, and a conflicted blocking
obligation is never satisfied whatever state the transitions left it in. This
layer does not pick a winner, for the reason `ContextResolution.conflicted`
does not: two sources of the same standing disagreeing is a fact about the
world, not a tie to be broken silently.

An independent source refusing what a *self-reporting* one claimed is not a
conflict. That is the verification mechanism working exactly as ADR §2 designs
it, and it has a state of its own.

## Kernel integration

An optional port, in exactly the sense `policyPackProvider`,
`governedAuthorityProvider`, `governedConstraintProvider` and `contextResolution`
are optional:

```
AocKernel.evaluate()
  ├─ resolveGovernedConstraintContext()   ← facts only
  ├─ resolveKernelContext()               ← facts only
  ├─ resolveKernelObligations()           ← lifecycle only, this module
  ├─ AocGuard.preflight()                 ← the decision is produced here
  ├─ applyGovernedAuthorityStep()         ← narrows only
  ├─ applyContextStep()                   ← narrows only
  └─ applyObligationStep()                ← adds a field; changes nothing
```

Obligations are resolved before the engine runs so `evaluate()` and `enforce()`
observe the same world in the same order. Nothing they produce reaches the
policy input: obligations are read *from* the decision's layers, never *into*
them, which is the one-way dependency rule (`D reads B`) and what keeps a
discharge from becoming something a policy rule could turn on.

### `evaluate()`

Reports, when the capability is configured:

```ts
result.status                                       // the authorization decision, untouched
result.reasonCodes                                  // the authorization reasons, untouched
result.obligations.obligations[]                    // id, type, blocking, state, satisfied,
                                                    // terminal, withholdsExercise, transitions, discharge
result.obligations.allBlockingObligationsSatisfied  // the aggregate ADR §3 turns on
result.obligations.exerciseEligibility              // 'eligible' | 'blocked'
result.obligations.exerciseReasonCodes              // OBLIGATION_* — a separate vocabulary
result.obligations.disregarded[]                    // observations that arrived and did not count
```

It issues no grant. The typed `ObligationEvaluation` is what the later Bounded
Grants phase will consume.

### `enforce()`

The executor is **not invoked** when a blocking obligation is unsatisfied, and
the authorization is reported exactly as the policy layers concluded it:

| decision | obligations | executor | `execution.withheldBy` |
| --- | --- | --- | --- |
| ALLOW | none declared, or all blocking ones satisfied | **runs once** | absent |
| ALLOW | a blocking one unsatisfied | **never runs** | `'obligation'` |
| ALLOW | a non-blocking one unsatisfied | **runs once** | absent |
| DENY | any state at all | **never runs** | absent — the denial is the reason |

On the withheld path the Kernel calls `guard.preflight()` rather than
`guard.enforce()`, because `enforce()` preflights and invokes in one synchronous
call and there is no point inside it at which an already-known obligation state
could stop it. The decision produced is the real one — same chain, same policies,
same reason codes — so the caller receives an authorization that stands next to
an execution that was withheld. It consumes the request's idempotency key
exactly as the existing non-executing paths through `enforce()` already do
(`guard.enforce()` preflights first on every path, so a denied or
approval-required enforcement claims the key today); this is therefore not a new
idempotency characteristic, and a caller re-submitting after a discharge uses a
fresh key for the same reason it already must after an `approval_required`.

Repeated `enforce()` calls cannot double-discharge or corrupt lifecycle state,
by construction rather than by a guard: nothing here mutates or consumes
anything (see "Persistence" below).

### Reason codes

`AOC_KERNEL_EXERCISE_REASON_CODES` is a **separate constant, in a separate file,
with a separate type** from `AOC_KERNEL_REASON_CODES`:

```
OBLIGATION_PENDING                a blocking obligation stands, unreported or merely outstanding
OBLIGATION_DISCHARGE_UNVERIFIED   reported by a self-reporting source; nothing independent confirmed it
OBLIGATION_DISCHARGE_REJECTED     an independent source refuted a reported discharge
OBLIGATION_EXPIRED                the discharge window closed with nothing valid inside it
OBLIGATION_DISCHARGE_CONFLICTED   two independent sources reported contradicting outcomes
```

They never appear in `result.reasonCodes`, and a structural test asserts the two
vocabularies do not overlap. Keeping them in one union would have made the
collapse the ADR rejects a typo away.

## Backward compatibility

Omitted — or configured with a declaration carrying no requirements — Kernel
behaviour is byte-identical to this layer not existing: no resolution is
attempted, the provider is not consulted, no field is added to the result, and
the Governance Record is unchanged.
`src/kernel/__tests__/characterization/obligation-capability-absent.test.ts`
pins both equivalences.

The frozen v1 HTTP surface is untouched: `check-api-freeze` reports the same 34
frozen routes wired and 27 endpoints it did before, `release/api-surface.v1.json`
is unmodified, there is no new endpoint, and there is nothing a caller can
submit. A caller **must not** be able to
discharge its own obligation, so there is deliberately no request field and no
route for it — the capability is composed at the host, never submitted over the
wire. `src/kernel/index.ts` gains type-only exports, so the checksummed
`dist/src/kernel/index.js` release artifact is byte for byte unchanged.

## Relationship to Context (layer C)

Two separate security boundaries, tested independently and together.

Layer C decides **what is true** — a caller's assertion cannot substitute for a
trusted context fact. Layer D decides **whether a condition on exercising
already-granted authority has been met** — a caller's assertion cannot
substitute for a trusted discharge. Neither substitutes for the other, and the
acceptance scenario asserts that: trusted context with a forged discharge gets
exactly as far as untrusted context with a real discharge, which is nowhere.

The two share a design *principle* and no code. There is no coupling between the
registries, and `context-resolution-runtime` and `obligation-runtime` do not
import each other — a structural test enforces it, because a context fact that
depended on an obligation would collapse the two boundaries into one.

## Persistence

**Nothing here is stored, and that is a design decision rather than a gap.**

An obligation's state is re-derived on every evaluation from (declaration +
observations + instant). Three properties follow that would otherwise have to be
defended with tests:

- **expiry is a state, not a job.** ADR §6: "derived from the clock at read time;
  no job is load-bearing." A stale discharge is stale the moment it is read.
- **repeated evaluation cannot double-discharge.** Two `enforce()` calls over the
  same world produce identical instances, because neither consumed anything.
- **a replay's Governance Record is identical.** There is no accumulated state
  for two runs to disagree about.

What a production adapter must therefore persist is the **observations**, and it
must guarantee:

1. **Durability and append-only semantics.** An observation, once recorded, is
   never edited. A correction is a new observation; the lifecycle's own ordering
   and the transition table decide what it means.
2. **Atomic, idempotent writes.** Re-delivering the same observation (a webhook
   retry, a replayed queue message) must not create a second row that could read
   as a second approval. Key on (obligation type, correlation, source,
   `observedAt`, outcome).
3. **Correlation-scoped reads.** `resolveObligationDischarges` must return
   observations for exactly the queried correlation. Returning more is safe —
   the layer discards them with `correlation_mismatch` — but returning fewer
   silently withholds a discharge that exists.
4. **A bounded, declared read latency.** This call sits in the synchronous
   decision path, so it inherits risk R1 from
   `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §9: an approval store's
   availability must not silently become authorization's availability. A
   production adapter needs a per-source timeout and a circuit breaker, and
   must fail by *throwing* — which this layer turns into `resolved: false` and a
   withheld exercise — rather than by returning an empty observation set, which
   would read as "nothing to discharge".
5. **No trust claim.** The adapter records what a source said and which source
   said it. It must never write a verification class or a lifecycle state; both
   are derived here, from operator configuration.

Bounded by the declaration: exactly the declared obligation types are queried,
once, for one correlation. Nothing scans global state, nothing loops unbounded,
and no test reaches a network.

## Relationship to future Bounded Grants (layer E)

This phase implements D only. It issues no grant, and the obligation runtime
does not import — and structurally cannot import — anything from the Grants
layer. The dependency runs:

```
Authority / Policy / Context
        ↓
    Obligations
        ↓
   future Grants
```

The typed `ObligationEvaluation` on the decision is the contract layer E will
read: `allBlockingObligationsSatisfied` is the aggregate ADR §3 makes grant
issuance turn on, and the per-instance state and discharge provenance are what a
grant's evidence must cite.

## Explicitly deferred

- **Bounded grant issuance, attenuation, token formats and grant persistence.**
  The whole of layer E. ADR §4–§5 and phase 8.
- **The evidence extension.** Obligation state as a first-class `EvidenceBundle`
  subject, with its own disclosure policy entry, is phase 9. Obligation state
  and provenance travel on the decision and are canonicalized with it; no bundle
  field, disclosure-policy entry or store schema changes here. Approval
  *payloads* never reach the record at all — `ObligationDischargeEvaluation` has
  no payload field, which is the "hidden by default" rule enforced at the type
  level rather than by a redaction rule someone has to remember.
- **A `DischargeProof` hash-chained with `EvidenceProof`/`ApprovalProof`.**
  ADR §1 proposes one. It belongs with the evidence extension, because a proof
  nothing verifies is the defect this phase closes, restated.
- **The wider obligation catalogue.** `require-mfa`, `record-usage`,
  `watermark-content`, `require-acceptance` and the rest.
- **Representing a refusal of an obligation nobody reported discharging.**
  See "Divergence from the ADR" — it needs an ADR edge that does not exist.
- **Policy-authored obligations.** `contextKey` predicates, derived-value nodes
  and per-rule declarations are phase 6; obligations move onto a pack with them.
- **A workspace package.** The ADR proposes `packages/obligation-lifecycle`. The
  port's only consumers are the Kernel and the composition root, both inside
  `src/` — exactly where `ContextResolverPort` is typed from today. Extracting
  it later is a mechanical move; doing it now would add a bundled dependency to
  a frozen release artifact for no consumer that exists.
- **Everything an approval system does.** No routing, assignment, escalation,
  reminder, SLA, schedule, queue, notification, inbox or organizational
  hierarchy traversal. Frontera understands "finance approval is required" and
  "a valid trusted finance approval has or has not been discharged". Obtaining
  it is the deployment's business, and the ADR is explicit that Frontera would
  be wrong to own it.
