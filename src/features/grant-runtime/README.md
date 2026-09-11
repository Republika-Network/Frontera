# Grant Runtime

Layer **E** of `docs/architecture/ADR-AUTHORITY-CONTROL-LAYERING.md`.

> **What bounded permission does this already-authorized, obligation-satisfied
> result produce — by whom, against what, under which bounds, and until when?**

That is the only question this module answers. It does not authorize anything,
and it cannot be made to: nothing exported from here carries an allow, a deny, a
policy effect or a decision status, and `tests/grant-layer-boundaries.test.ts`
fails the build if one ever appears.

## The one invariant

> **GRANT ⊆ AUTHORIZED AUTHORITY**

A grant may preserve a bound, narrow a bound, shorten a duration, lower a limit,
reduce a resource set or constrain an action. It may never widen one, and there
is no configuration, posture or caller payload that makes it possible.

`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4: "**Attenuation only.** A
grant ⊆ its decision, exactly as a `DelegationGrant` ⊆ its source in Authority
Graph. Same rule, same reason, now applied one layer down."
`ADR-AUTHORITY-CONTROL-LAYERING.md` §5 and
`TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4 invariant 5 restate it as layer
law.

It is enforced in types, in a service and in tests rather than in this sentence:

- `compareGrantBound` is total over a closed algebra of four bound shapes and
  answers `equal` / `narrower` / `broader` / `incomparable`;
- `attenuateGrantScope` permits the first two and refuses the other two;
- `grantScopeIsWithin` re-derives the invariant **of the artifact**, independently
  of the function that produced it, and issuance refuses if it does not hold;
- `tests/grant-attenuation.test.ts` enumerates, per bound shape, a source bound
  and the four positions a requested bound can take relative to it.

If a requested grant cannot be *proven* equal to or narrower than its source, no
grant is issued. There is no third direction.

## The one thing that is not true

> **ALLOW does not mean a grant exists.**

An authorization decision answers "is this action authorized under the evaluated
authority and policy?". A grant answers "what exact portion of that authorized
authority may now be exercised?". They are different facts and this module
reports them side by side, never folded:

```
authorization decision  = ALLOW
blocking obligation     = not yet discharged
grant eligibility       = INELIGIBLE
grant                   = ABSENT
```

and, in the other direction:

```
authorization decision  = DENY
blocking obligation     = satisfied
grant eligibility       = INELIGIBLE
grant                   = ABSENT
```

Neither combination rewrites the decision, and nothing here can:
`assessGrantEligibility` receives a `GrantSourceAuthorization`, which carries no
status to rewrite. `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 is what
that protects — "policy said no" and "policy said yes, conditionally, and the
condition was not met" are different facts about a request, and a system that
reports them identically has destroyed the more useful one.

## Grant eligibility

Three conditions, assessed together so a caller learns every one it fails:

| condition | ADR |
| --- | --- |
| the authorization permitted exercise | §4.2, hard invariant 3 |
| every **blocking** obligation is satisfied (`verified` or `waived`) | §4.2, §3, hard invariant 4 |
| the source states enough deterministic, well-shaped scope to prove ⊆ against | §4.4, §4.5 |

The third is the fail-closed one. A source that does not state a mandatory bound
is not a source that bounded it generously — there is nothing to attenuate from,
and an unbounded grant is never the fallback.

## Source authorization

A grant is always derived from one specific authorization, and the authorization
is **read**, never trusted. `GrantSourceAuthorization` is the projection layer E
is allowed to see:

| field | what it is |
| --- | --- |
| `correlation` | `requestId` + `decisionId` + `action` + `resourceScope`, all four exact |
| `subject` | the party the authorization was evaluated for |
| `scope` | the bounds it stood under — the parent of every comparison |
| `authorizationPermitsExercise` | a boolean the **Kernel adapter** computed from the decision |
| `allBlockingObligationsSatisfied` | the aggregate ADR §3 makes issuance turn on |
| `evaluatedAt` | the anchor the validity horizon is measured from |

There is no status, no outcome, no effect and no authorization reason code on
that type, and the omission is the design. `ADR-AUTHORITY-CONTROL-LAYERING.md`
§4 makes the Kernel the only decision producer and gives layer E no standing to
interpret a decision, so what crosses the boundary is a boolean. Handing this
layer `'allowed' | 'denied'` would have given it the vocabulary to form an
opinion; handing it a boolean the decision already settled gives it nothing to
do but obey.

**The source is immutable from here.** Nothing in this module mutates a
decision, a policy result, a context result or an obligation result, and there
is no code path that could: the projection is built by the Kernel adapter from
an already-frozen result, every field is `readonly`, and issuance consumes it by
value. A grant is a derived artifact.

## Supported bounds

Six axes, each justified by something the current architecture already carries.

| key | shape | source value |
| --- | --- | --- |
| `action` | `identity` | the capability/action the authorization evaluated |
| `resources` | `set` | the resource scope(s) it evaluated |
| `counterparty` | `identity` | the counterparty it evaluated |
| `organization` | `identity` | the tenant it was scoped to |
| `amount` | `ceiling` | the quantity it evaluated, with its currency |
| `validity` | `window` | the horizon operator configuration allows off it |

`action`, `resources` and `validity` are mandatory: a source that does not state
all three cannot be attenuated from.

Four bound shapes and no fifth. There is deliberately **no** expression shape,
no predicate shape, no wildcard shape and no negation, and nothing here parses,
compiles or executes anything — no `eval`, no `new Function`, no dynamic import,
no user-supplied predicate. A requested `'*'` against a source `'payment'` is
simply a different identity value, and it is refused for that reason rather than
by a wildcard rule someone has to remember to write.

### The source ceiling is what was evaluated, not what a rule permits

Worth stating plainly, because it is where the brief's worked example and this
implementation differ. For a request of `amount = 7500` under a policy reading
`amount <= 10000`, the source ceiling is **7500**, not 10000.

The policy's `10000` is a *rule*, not a bound the decision recorded, and no
decision record in this repository carries a rule's threshold —
`EnterpriseAccessDecision`, `GovernanceEvaluationRecord` and
`KernelEvaluationResult` all carry what was evaluated and none carries what a
condition compared it against. Granting up to 10000 off a decision taken about
7500 would grant authority over an amount nothing ever evaluated, which is
exactly the broadening this layer refuses. The acceptance scenario asserts a
10000 grant is rejected for that reason.

Note what reading the request's own `amount` as a *ceiling* is and is not. It is
not a re-reading of the request as fact — layer C exists precisely because a
caller's claim is not evidence about the world. It is the different question of
what the decision covered, and the answer to that is, by construction, the input
the decision was given. A grant at or below it is inside what was authorized.

## Subject semantics — no delegation

A grant's holder is the subject the source authorization was evaluated for, and
a request naming a different holder is refused with `GRANT_SUBJECT_INVALID`.

**This phase introduces no delegation, and nothing here could express one.** No
accepted ADR defines delegation for grants: `ADR-NATIVE-DELEGATED-CAPABILITIES.md`
and Authority Graph's `DelegationGrant` define delegation over *authority*,
upstream of a decision, and neither gives a grant the power to name a holder the
decision did not authorize. Absent an ADR, converting an authorized subject into
a different grant subject is broadening, and the default posture is the closed
one.

## Expiry

Deterministic, derived from an **injected** instant at read time, and never from
a sweeper having run. `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §6 and hard
invariant 7: "A grant past its own `expiresAt` is expired **when read** … A
sweeper may exist for provider enforcement and for housekeeping, and it is an
optimization: correctness never depends on it having run."

There is therefore no timer, no job and no scheduled sweep in this module, and
no `Date.now()` — a structural test fails the build if one appears.

A malformed instant makes a grant **unusable**, never usable-forever. That is
the opposite of `isObligationExpiredAt`'s treatment of a malformed deadline, and
deliberately so: there, a malformed deadline leaves a *blocking* obligation
blocking; here, a malformed horizon on a *permission* must not read as no
horizon at all. Both are the closed direction for what they govern.

### An underdetermination in the accepted ADR, and how it is resolved

ADR §4.5 requires that a grant's `expiresAt` "must not exceed any bound the
decision set", and hard invariant 2 restates it. Both are conditional on the
decision having set one — and **no decision record in this repository carries a
validity bound.** `EnterpriseAccessDecision` has `evaluatedAt` and no horizon;
`GovernanceEvaluationRecord` has `evaluatedAt`/`persistedAt` and no horizon;
`KernelEvaluationResult` has `evaluatedAt` and no horizon. Read literally, §4.5
is vacuous for time, and a grant could be issued with any expiry, or none.

That is an *underdetermination*, not a contradiction — §4.5 is well defined
whenever a bound exists, and simply says nothing when one does not. It is
resolved in the one direction `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §4
invariant 6 gives every unresolvable state: **closed**. The horizon is
operator-declared (`GrantDeclaration.maximumGrantLifetimeSeconds`), the source
validity bound is `evaluatedAt + maximumGrantLifetimeSeconds`, and a deployment
that declares no horizon gets no grants rather than unbounded ones. There is no
value meaning "unlimited" and no way to express one.

The deadline reaches this layer by the same route an obligation deadline does —
trusted operator configuration, never caller-controlled request data — which is
ADR hard invariant 8 applied one layer over. A zero, negative or non-finite
horizon is rejected when the Kernel is **wired**, not when a payment is
evaluated.

## Revocation

The existing revocation architecture, reused rather than duplicated.
`GRANT_REVOCATION_REASONS` is the same closed seven-value vocabulary as
`ENTERPRISE_GRANT_REVOCATION_REASONS` (`ADR-GRANT-REVOCATION.md`), asserted
identical by `tests/grant-lifecycle.test.ts` so the two cannot drift into the
second, incompatible revocation subsystem that ADR itself warns against.

A revocation is an immutable **event** held beside the grant, not a mutable
status on it. That extends `ADR-ACCESS-GRANT.md`'s own reasoning for excluding
`'expired'` from a status vocabulary — a second, independently-settable source
of truth for the same fact — to revocation as well, so neither expiry nor
revocation can drift from what it describes.

It is deterministic, inspectable, correlated to grant identity, **idempotent**
(a second revocation returns the first unchanged and never re-dates it) and
fail-safe. Revoking a grant that was never issued is refused, never silently
recorded.

**Revocation never changes the historical authorization.** A decision that
concluded allow concluded allow, permanently; what changes is whether the grant
may still be exercised. The acceptance scenario asserts exactly that.

There is no notification, routing or orchestration here, and nothing that could
be. Provider-side enforcement of a revocation — measuring when it truly becomes
effective against an already-issued provider credential — is
`src/enterprise/access-governance`'s existing, separate concern, untouched by
this layer.

## Usage and replay — deliberately not implemented

**Every accepted ADR is silent on single-use, multi-use, usage count,
consumption and replay for grants.** `ADR-ACCESS-GRANT.md` enumerates what a
grant carries and no counter appears; `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`
§4–§6 covers derivation, validity and expiry and says nothing about
consumption; `ADR-GRANT-REVOCATION.md` and `ADR-USAGE-EVENT.md` treat observed
use as a *separate record about* a grant, not a decrement of one.

So this phase implements issuance, validity and revocation, and invents no
consumption model. A `BoundedGrant` carries no usage counter and no consumption
field, and adding one is a new decision and a new ADR rather than a field
smuggled in to make an implementation possible. Were usage bounds to be
specified later, the place for them is inside the store transaction — decrement
atomically, never increase, never replay beyond the declared bound — which is
why `BoundedGrantStorePort.issue` already carries a commit guard.

## Deterministic identity

`boundedGrantId` is derived from the correlation, the subject and the canonical
bounds, and from nothing else — no UUID, no counter, no clock, no ambient
randomness. A structural test fails the build if `randomUUID`, `Math.random`,
`randomBytes` or a `nextId` call appears.

It buys three things: two issuances of the same grant over the same authority
collide rather than duplicate, a replay produces a byte-identical artifact, and
identity is assertable by construction. It is the discipline
`obligationInstanceId` established one layer down.

## Integrity and canonicalization

`serializeGrantScope` and `serializeBoundedGrant` produce a deterministic
canonical form: keys in fixed lexicographic order, sorted and de-duplicated set
members, `-0` normalized to `0`, absent rather than `null` for an unstated axis,
no whitespace. Those are the rules `aoc.canonical-json.v1` applies, and
`tests/grant-determinism.test.ts` pins the **byte equality** against the real
Governance Store canonicalizer rather than asserting it in prose — layer E may
not import layer F (`ADR-AUTHORITY-CONTROL-LAYERING.md` §2: F reads E, never the
reverse), and a rule restated by hand is a rule that can drift.

`grant.digest` is `sha256:<hex>` over that canonical form, matching `computeDigest`
and the `*Proof` families already in `src/features`. A grant whose fields were
edited after issuance no longer matches it and is refused at read time, never
repaired.

**This is integrity, not a signature.** It detects that a grant's fields differ
from the ones that were digested. It is not non-repudiation and it is no defence
against a privileged writer able to rewrite both a grant and its digest — the
same limit the Governance Store states for its own digests, and the honest one
to state here.

### No token format

A bounded grant is an **internal, typed record held by a trusted store**. It is
not a JWT, macaroon, UCAN, OAuth token, signed URL, capability token or ledger
object; a caller never holds one and therefore never presents one.
`ADR-ACCESS-GRANT.md` lists every one of those as an explicit
non-responsibility and enforces it with `@ts-expect-error` proofs, and no
accepted ADR has since chosen an external serialized token format. Locking
Frontera to one now would be a decision this phase has no mandate to make, and a
structural test refuses the vocabulary outright.

Cryptographic signing is therefore **deferred to signer integration**, and this
is where it would attach: over `serializeBoundedGrant`'s output, as a detached
signature recorded beside the grant, leaving the canonical form and the digest
unchanged.

## Transactional issuance

`ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 and hard invariant 6
require every issuance check to run "inside the store's own transaction, against
the records read there — the same commit-boundary discipline
`ADR-GOVERNED-CONSTRAINT-APPLICABILITY.md` §3 established for
`acquireReservation`, so no check is performed against a world that has since
moved."

That is a statement about *where* a check runs, so it is expressed in the port's
shape rather than in a comment. `BoundedGrantStorePort.issue` takes a
**synchronous** `commitGuard`, called inside the store's critical section after
the records it decides on have been read there. A guard that were `async` would
reintroduce exactly the interleaving the discipline prevents, so the type
forbids it.

The TOCTOU this closes:

```
1. evaluate   the decision permits, every blocking obligation is satisfied
2. ...        the approval is withdrawn / the authority narrows / a revocation lands
3. issue      a grant minted from the stale assumption at step 1
```

`tests/grant-transaction-boundary.test.ts` makes step 2 really happen between
the measurement and the commit, for each of those causes, and asserts the
refusal. Nothing is faked with a comment.

`createInMemoryBoundedGrantStore` is one synchronous critical section per
mutating method, with no `await` between the read that decides and the map
mutation that records — the structure `createInMemoryAccessGrantStore` and
`createInMemoryAuthorityStore` already use.

### What a production adapter must guarantee

In-memory proves the slice; nothing survives a restart. A durable adapter
(`createSqliteAccessGrantStore` is the shape to follow) must provide:

1. **Atomic issuance** — guard, duplicate check, preclusion check and write
   commit together or not at all.
2. **Idempotency on grant identity** — ids are deterministic, so a re-delivered
   issuance resolves to the existing grant rather than creating a second row
   that would read as a second grant.
3. **Deterministic lookup** — the grant named, or nothing. A near match is worse
   than nothing.
4. **Revocation visibility** — a revocation committed before a read is visible
   to that read, never lost to a cache.
5. **Expiry from the passed-in instant**, never the database's own clock, so a
   replay and a live read agree.
6. **Concurrency safety** — two concurrent issuances of one identity produce one
   grant and one `already-issued`, never two grants.
7. **Correlation integrity** — the stored correlation is the one issuance
   computed; never rewritten, defaulted or normalized.

A store that cannot honour these must fail by **throwing** rather than by
returning a permissive result: the layer above turns a throw into "no grant",
which is the closed direction.

The same applies to `revalidateSource`. Omitted, the source is re-checked
against itself, which still closes duplicate issuance and preclusion but **not**
a genuinely concurrent change of the underlying authorization. A production
deployment supplies one, reading the authoritative decision — in this repository
that is `GovernanceStore.getByDecisionId` — and it must answer synchronously, so
a deployment that cannot pre-loads the answer before calling `issueGrant`,
exactly as `acquireReservation`'s callers pre-load what they hand it.

## Evaluation is not issuance

The repository already separates pure evaluation from mutation everywhere —
`preflight` versus `enforce`, `resolveAvailability` versus `acquireReservation` —
and this phase keeps that line rather than blurring it.

| | `AocKernel.evaluate()` | `GrantIssuanceService.issueGrant()` |
| --- | --- | --- |
| answers | "would this be grant-eligible?" | "create the bounded artifact" |
| touches a store | no | yes, under its commit boundary |
| produces | `result.grants` — eligibility and source bounds | a `BoundedGrant` |
| purity | two evaluations of one world agree | stateful by design |

`evaluate()` therefore needs no writable dependency and is given none:
`KernelGrantOptions` carries a declaration and nothing else. A host that also
wants to issue composes `createGrantIssuanceService` against the same
declaration. Putting a write inside `evaluate()` would have put it inside a
function three characterization suites assert is side-effect free.

## Kernel integration

An optional port, in exactly the sense `policyPackProvider`,
`governedAuthorityProvider`, `governedConstraintProvider`, `contextResolution`
and `obligations` are optional:

```
AocKernel.evaluate()
  ├─ resolveGovernedConstraintContext()   ← facts only
  ├─ resolveKernelContext()               ← facts only
  ├─ resolveKernelObligations()           ← lifecycle only
  ├─ AocGuard.preflight()                 ← the decision is produced here
  ├─ applyGovernedAuthorityStep()         ← narrows only
  ├─ applyContextStep()                   ← narrows only
  ├─ applyObligationStep()                ← adds a field; changes nothing
  └─ applyGrantStep()                     ← adds a field; changes nothing
```

`applyGrantStep` runs last, after the obligation step, because eligibility is a
function of what the decision concluded *and* of whether every blocking
obligation on it is satisfied. Like `applyObligationStep` and unlike the two
narrowing steps before it, it cannot change the outcome it is handed: it reads
no `status`, no `reasonCodes`, no `summary` and no `policies`, and a structural
test asserts that of the function's source.

### `evaluate()`

Reports, when the capability is configured:

```ts
result.status                          // the authorization decision, untouched
result.reasonCodes                     // the authorization reasons, untouched
result.grants.eligibility              // 'eligible' | 'ineligible'
result.grants.ineligibilityReasonCodes // GRANT_* — a separate vocabulary
result.grants.correlation              // requestId, decisionId, action, resourceScope
result.grants.subject                  // the only party a grant may be held by
result.grants.sourceBounds[]           // what such a grant would be narrowed from
```

It carries no grant, no grant id and no token, and a test asserts the absence of
each.

### Why `enforce()` is unchanged

Deliberately, and this is the one place the phase brief and the accepted
architecture had to be reconciled explicitly.

**No accepted ADR gives grants a role in `enforce()`.** ADR §4–§6 covers
derivation, validity, expiry and revocation and says nothing about gating an
executor; the ADR's own gate on execution is the *obligation* gate, which layer
D already implements and which this phase leaves exactly as it found it. Making
a configured grant capability withhold the executor would be inventing a
lifecycle semantic the architecture does not state — the precise mistake the
previous phase's post-mortem records, where an implementation read a diagram
rather than the prose and arrived at a seventh obligation state nobody had
defined.

What the brief's enforcement cases actually require is a *read-time
exercisability check*, and that exists: `GrantIssuanceService.assessExercise`
answers "may this grant be exercised at this instant?" and returns `unusable`
for an expired grant, a revoked grant, a tampered grant and an unknown grant id.
A broader-than-authority grant never reaches it, because it could never have
been issued. Wiring that check into an execution path is the execution-adapter
phase's work, and the adapter is the thing that has a grant to present.

`enforce()` therefore behaves exactly as it did: the capability adds a field to
the result and gates nothing. A characterization test asserts the executor still
runs exactly once with the capability configured.

### Reason codes

`GRANT_REASON_CODES` is a **separate constant, in a separate file, with a
separate type** from `AOC_KERNEL_REASON_CODES` (authorization) and
`AOC_KERNEL_EXERCISE_REASON_CODES` (obligations), and structural tests assert
the three vocabularies do not overlap and that every grant code is `GRANT_`-
prefixed.

```
GRANT_AUTHORIZATION_NOT_PERMITTED   the authorizing layers did not permit exercise
GRANT_OBLIGATIONS_UNSATISFIED       a blocking obligation stands
GRANT_SOURCE_BOUNDS_INCOMPLETE      the source states no bound to attenuate from
GRANT_SCOPE_BROADENING              a requested bound is broader than its source
GRANT_BOUND_INCOMPARABLE            a requested bound cannot be compared to its source
GRANT_SUBJECT_INVALID               the holder is not the authorized subject
GRANT_CORRELATION_INVALID           the issuance names a different authorization
GRANT_VALIDITY_INVALID              no usable validity window
GRANT_ELIGIBILITY_CHANGED           the world moved before the commit
GRANT_ALREADY_ISSUED                the identity already stands
GRANT_EXPIRED                       read at or after its expiresAt
GRANT_REVOKED                       a revocation stands
GRANT_NOT_FOUND                     the store holds no such grant
```

"Grant issuance failed" is never encoded as a policy `DENY`, and a denied
decision is never re-labelled as a grant failure. Keeping the three in one union
would have made that collapse a typo away.

## The caller security boundary

**The public requester cannot self-issue or broaden a grant**, for two
independent reasons, both tested from the attacker's side in
`src/kernel/__tests__/kernel-grant-self-assertion.test.ts` and in the acceptance
scenario's case I.

1. **Nothing reads a caller's grant claim.** A `GrantSourceAuthorization` is
   projected from the typed request and the Kernel's own decision id; the
   narrowing a grant is issued under is *host* input supplied through the
   issuance service; `KernelEvaluationRequest` carries no grant field and there
   is no route, no endpoint and nothing to submit.
2. **`aoc.grant` is reserved anyway.** Every key in a caller's free-form context
   bag that is `aoc.grant` or sits under it is dropped before the bag travels
   anywhere, whether or not a grant capability is configured — the third
   application of the rule `request-adapter.ts` applies to `organizationId`,
   `aoc.context` and `aoc.obligations`.

The payloads measured include `{"grant":{"maxAmount":1000000}}`,
`{"aoc.grant":{"action":"*"}}`, `{"grantEligible":true}`,
`{"grant":{"expiresAt":"2099-01-01T00:00:00Z"}}` and
`{"grant":{"subject":"attacker"}}`. Each changes nothing: the entire grant
evaluation is asserted byte-identical with and without them.

The trusted path refuses the same things for the same reasons. A *host* that
asks for the bounds the forgery named is refused axis by axis, because issuance
proves ⊆ rather than believing a request.

## Relationship to Context (layer C) and Obligations (layer D)

Three separate security boundaries, tested independently and together.

Layer C decides **what is true** — a caller's assertion cannot substitute for a
trusted context fact. Layer D decides **whether a condition on exercising
already-granted authority has been met** — a caller's assertion cannot
substitute for a trusted discharge. Layer E decides **what portion of authorized
authority may now be exercised** — a caller's assertion cannot substitute for an
authorization that happened.

The grant runtime imports **neither** C nor D, and a structural test enforces
it. It reads one aggregate boolean about obligations and one about the decision,
both projected by the Kernel adapter, because a grant layer that could reach
into a discharge could reinterpret one.

The dependency runs one way:

```
Authority / Policy / Context
        ↓
    Obligations
        ↓
      Grants
        ↓
 future execution path
```

## Backward compatibility

Omitted, Kernel behaviour is byte-identical to this layer not existing: no
eligibility is assessed, no field is added to the result, no namespace reaches
policy, and the Governance Record is unchanged.
`src/kernel/__tests__/characterization/grant-capability-absent.test.ts` pins
that, and also pins the stronger property that *configuring* the capability
leaves the authorization half of the result byte-identical.

The frozen v1 HTTP surface is untouched: `check-api-freeze` reports the same 34
frozen routes and 27 endpoints, `release/api-surface.v1.json` is unmodified,
there is no new endpoint, and there is nothing a caller can submit — deliberately,
because a caller must not be able to issue its own grant. `src/kernel/index.ts`
gains type-only exports, so the checksummed `dist/src/kernel/index.js` release
artifact is byte for byte unchanged.

## Persistence

The store is a port with a documented contract and an in-memory implementation.
No schema is migrated, no existing store is modified, and no Governance Store
schema identifier changes, so every durability and portability drill passes
unchanged.

## Future execution adapters

A grant is provider-neutral and stays that way. Nothing here calls a ledger,
constructs or signs a transaction, binds to a sequence number, touches a wallet
or reaches a provider — a structural test refuses the vocabulary. An execution
adapter consumes a grant; it is not part of one.

## Future Evidence

This is not the Evidence phase, and no bundle field, disclosure-policy entry or
store schema changes here. Grant eligibility and source bounds travel on the
decision and are canonicalized with it.

What this phase does do is keep the correlations a later Evidence phase will
need intact. `GrantCorrelation` is stable and exact on four fields, the grant
carries `sourceDigest` and `digest`, and revocation is correlated to grant
identity — enough for Evidence to later represent:

```
decision → obligation satisfaction → grant issuance → exercise → revocation/expiry
```

No event system is added here. The point is only that nothing needed later has
been destroyed.

## Explicitly deferred

- **Execution and exercise.** Presenting a grant to an adapter, and gating an
  external action on one. `assessExercise` is the primitive; wiring it into an
  execution path is the execution-adapter phase's work.
- **Cryptographic signing of a grant**, and any external token format. Deferred
  to signer integration; the attachment point is documented above.
- **The Evidence extension.** Grant issuance, expiry and revocation as
  first-class `EvidenceBundle` subjects with their own disclosure policy entry.
- **A usage/consumption model.** No accepted ADR specifies one; see above.
- **Delegation.** No accepted ADR defines it for grants; the default posture is
  no delegation.
- **A durable grant store.** The port's production guarantees are stated; a
  SQLite or Postgres adapter is not built.
- **Extending `packages/access-grant`.** `TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md`
  §6 anticipates optional decision-binding fields on `EnterpriseAccessGrant`.
  They are not added: the frozen contract has no consumer for them in this
  phase, and widening a published package would put a new bundled dependency
  into a checksummed release artifact for no caller that exists. `BoundedGrant`
  carries the bounds instead, inside `src/features` where
  `ContextResolverPort` and `ObligationDischargeProviderPort` already live.
  Extracting or merging later is a mechanical move.
- **Binding the existing `AccessGrantService.issueGrant` to a verified
  decision.** ADR §4–§5's `decisionRef` binding and the
  `grants.decisionBinding: 'off' | 'report' | 'require'` posture apply to the
  Sovereign Access / Pinata grant path in `src/enterprise/access-governance`,
  which is a resource-access grant over a provider rather than the
  authority-bounded artifact this layer produces. The attenuation engine here is
  what that binding would call; connecting them is a separate, additive change
  and is not made in this phase.
- **A workspace package.** The ADR proposes `packages/obligation-lifecycle` and
  friends; the same reasoning applies here, and the same answer: the port's only
  consumers are the Kernel and the composition root, both inside `src/`.
