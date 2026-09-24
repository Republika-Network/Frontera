# Authority-Controlled Execution

- Status: implemented, opt-in, no HTTP surface
- Layer: the composition between **E — Grants** and the execution boundary in
  `docs/architecture/TARGET_AUTHORITY_CONTROL_ARCHITECTURE.md` §2
- Code: `src/features/execution-runtime/`, `src/enterprise/execution-governance/`
- Prerequisite reading: `src/features/grant-runtime/README.md`,
  `docs/architecture/ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md`,
  `docs/architecture/ADR-PROVIDER-ADAPTER-CONTRACT.md`

## 1. Purpose

Connect the already-built authority-control pipeline to a real,
provider-neutral execution boundary, and make one rule true of every flow that
adopts it:

> **No external execution occurs through the grant-aware path unless a bounded
> grant held by the authoritative store has been successfully exercise-checked
> against the exact action being attempted.**

```
no grant                     -> adapter NOT called
unknown grant                -> adapter NOT called
expired grant                -> adapter NOT called
revoked grant                -> adapter NOT called
tampered grant               -> adapter NOT called
wrong subject                -> adapter NOT called
wrong action                 -> adapter NOT called
wrong resource               -> adapter NOT called
wrong counterparty / tenant  -> adapter NOT called
amount above the ceiling     -> adapter NOT called
correlation mismatch         -> adapter NOT called
valid grant, action inside   -> adapter called exactly once
```

Every row is a test that counts the adapter's invocations, because a refusal
that still reached a provider would have failed at the only thing this phase
exists to guarantee.

## 2. Authorization is not exercise

Frontera has two moments, and this composition keeps them as two calls.

| | `authorize()` | `exercise()` |
| --- | --- | --- |
| asks | under what authority may this action be exercised? | is *this* grant still valid and sufficient for *this* action right now? |
| runs | authority, context, policy, obligations, then issuance | a fresh authoritative read, then containment, then the adapter |
| produces | a decision **and**, separately, a grant or a refusal | an `ExecutionOutcome` |
| touches a provider | never | only on a usable assessment |

Folding them together would make the interesting cases unobservable: a grant
issued at T+0 may be exercised at T+5m, expire at T+10m, and be revoked at any
point in between.

### The decision is never rewritten

Every outcome carries the `KernelEvaluationResult` exactly as the Kernel
produced it. A grant withheld and an exercise refused leave the authorization
untouched, permanently:

```
decision              = ALLOW
grant                 = expired / revoked / absent
exercise eligibility  = BLOCKED
executor              = NOT CALLED
authorization history = ALLOW
```

This is `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §3 carried one step
further down. "Policy said no", "policy said yes and the condition was not met",
and "policy said yes, a grant was issued, and the grant is no longer usable" are
three different facts, and a system that reports them identically has destroyed
the two more useful ones.

## 3. `AocKernel.enforce()` is unchanged

Deliberately, and this is the accepted reading rather than a convenience.

**No accepted ADR gives grants a role in the executor gate.** ADR §4–§6 covers
derivation, validity, expiry and revocation and says nothing about withholding
an executor; the ADR's own gate on execution is the *obligation* gate that layer
D already implements. Making a configured grant capability withhold
`enforce()`'s executor would have invented a lifecycle semantic the architecture
does not state — the exact mistake the previous phase's post-mortem records.

What the enforcement cases actually require is a read-time exercisability check,
and `GrantIssuanceService.assessExercise` already provided the primitive. The
grant runtime's README names wiring it into an execution path as this phase's
work, and that is what `GrantExecutionService` is. So:

- `evaluate()` — unchanged;
- `enforce()` — unchanged, executor still runs exactly once;
- grant-aware execution — a separate, explicitly-composed path.

The Kernel remains the authority-control orchestrator and the only decision
producer. Provider execution stays outside it, which is the pattern the
repository already follows.

## 4. The first production composition path

`createAuthorityControlledExecution()` in `src/enterprise/execution-governance/`,
composed by `createEnterprise({ authorityControlledExecution })`.

```
createAuthorityControlledExecution({
  kernel,                    // grant-aware AocKernel
  grantCapability,           // the same GrantDeclaration the Kernel evaluates under
  grantStore,                // BoundedGrantStorePort
  executionAdapter,          // provider-neutral
  resolveAuthorityBinding,   // REQUIRED — see §5
  revalidateSource,          // optional commit-boundary decision re-read
  now,                       // injected clock
})
```

It is chosen for the reasons the phase brief names: the path already has
authority, request identity, action, resource and subject (all from
`KernelEvaluationRequest`), and it composes onto an executor abstraction rather
than inventing a product surface. It is not XRPL, not a wallet, not a signer,
and not a redesign of any existing flow.

### Grants are not enabled globally

Adopting this capability composes a **separate, grant-aware `AocKernel`
instance** over the same providers and policy pack. The Kernel behind
`POST /api/governance/evaluate` is composed exactly as it was, so:

- its `KernelEvaluationResult` gains no `grants` block;
- the Governance Record it commits is byte-identical to a deployment that never
  adopted layer E (the record projection spreads the whole result, so a `grants`
  block would otherwise enter it);
- `contextResolution`, `obligations` and `grants` are not switched on for every
  route merely because the runtimes exist.

Both instances read the same authority world. Only the capability set differs.

## 5. The authority ceiling, and the wiring hazard it closes

`GrantSourceAuthorization.validityCeilings` permits `[]`, and that is correct:
ADR §4 rule 4 measured that no decision record in this repository carries a
validity window, so on the generic Kernel path there is often nothing to contain
against and none is invented.

But an empty list cannot distinguish two very different facts:

```
A.  no upstream authority validity window applies to this action
B.  a mandate governs this action and the host forgot to pass its expiry
```

In case B an empty list would silently issue a grant that may outlive the
authority justifying it — a breach of ADR hard invariant 10 that nothing would
report. That is a *wiring* hazard, not a layer E defect, so it is closed at the
composition boundary and layer E's generic semantics are untouched.

### `GrantAuthorityBinding`

```ts
type GrantAuthorityBinding =
  | { kind: 'bounded-authority'
      authorityKind: 'mandate' | 'representative-authority'
                   | 'governed-authorization-artifact' | 'reservation'
      authorityRef: string
      expiresAt: string }            // required; a real instant or it is refused
  | { kind: 'no-temporal-authority-bound'
      sourceKind: 'standing-capability' | 'organizational-authority' | 'none-applicable'
      justification: string }        // required; blank is refused
```

There is no third option and no default. `bounded-authority` without an
`expiresAt` does not compile; `no-temporal-authority-bound` costs an explicit
`sourceKind` and an explicit `justification`, so it cannot be arrived at by
omission. This is the discipline `scopeLimit` and the grant declaration already
follow — the permissive case must cost an explicit word — applied to the one
value whose absence is indistinguishable from its non-existence.

### How a missing ceiling fails closed

`resolveAuthorityBinding` is a **required** composition option: a host cannot
build the service without answering the question. At runtime:

| situation | outcome |
| --- | --- |
| resolver returns `undefined` | `authority-binding-unresolved`, `AUTHORITY_BINDING_UNRESOLVED`, no grant |
| resolver returns a malformed binding | `authority-binding-unresolved`, `AUTHORITY_BINDING_MALFORMED`, no grant |
| bounded binding, issuer expiry within it | grant issued, `effectiveValidityCeiling` reports it |
| bounded binding, issuer expiry beyond it | `grant-withheld`, `GRANT_SCOPE_BROADENING`, refused and never clamped |
| unbounded binding, well justified | grant issued on the issuer's finite expiry, no ceiling reported |

The binding vocabulary is its own constant with its own type, disjoint from the
policy, obligation, issuance and exercise vocabularies — asserted, not claimed.

## 6. Amount semantics — the ceiling is authority (P10)

```
request amount     = 25          the proposed effect
policy threshold   = ALLOW when amount <= 10000     a rule, never a ceiling
authority ceiling  = 100         durable `max_amount` on the authority lineage
grant ceiling      = 100         NOT 25, NOT 10000
```

Until P10 ("Model A") the grant's source ceiling was the amount the request
stated. The Kernel projection now states **no amount bound**. For a
host-classified financial action, the issuance core resolves the durable
monetary authority on the decision's own authority lineage (the Kernel
Authority Store's `max_amount` / `spending_limit`), proves
`requested ≤ ceiling` exactly, and attaches the authority's ceiling. A request
above the ceiling gets no grant (`financial-authority-withheld`,
`FINANCIAL_AUTHORITY_CEILING_EXCEEDED`), so no reservation is made and no
adapter is called. The grant inherits the authority ceiling. A trusted issuer
may narrow it (`requestedBounds.amount`, e.g. 50) and may never broaden it.

At **exercise** time the rule still holds: an attempt above the grant ceiling
is refused with `GRANT_EXERCISE_AMOUNT_EXCEEDED` and the adapter is not called.
The financial authority is re-resolved inside the commit guard and again by P7
before and after the reservation, and the authority's durable spending limits
are enforced through P7's one atomic reservation.

A financial action with no resolvable monetary authority, or composed without
`exerciseControls` + `financialAuthority`, is withheld at issuance. See
`docs/architecture/ADR-AUTHORITY-SOURCED-PAYMENT-CEILINGS.md` and
SEC-INV-094 … SEC-INV-101.

## 7. Exercise-time validation

`GrantExerciseRequest` carries a **grant reference and no grant**. A bounded
grant is an internal typed record held by a trusted store; a caller never holds
one and therefore never presents one (`ADR-ACCESS-GRANT.md`, and the grant
runtime's "No token format"). So the trusted grant is re-read on every attempt
and the caller's description of it has no shape to arrive in.

Checked, all of them, with every failing reason reported:

| # | check | reason code |
| --- | --- | --- |
| 0 | the request states every field a comparison needs | `GRANT_EXERCISE_REQUEST_MALFORMED` |
| 1 | the authoritative store holds the grant | `GRANT_EXERCISE_NOT_FOUND` |
| 2 | its digest still matches its fields | `GRANT_EXERCISE_INTEGRITY_INVALID` |
| 3 | it has not expired, against the injected clock | `GRANT_EXERCISE_EXPIRED` |
| 4 | no revocation stands beside it | `GRANT_EXERCISE_REVOKED` |
| 5 | the attempting party is the holder | `GRANT_EXERCISE_SUBJECT_MISMATCH` |
| 6 | the correlation names the same authorization, exact on four fields | `GRANT_EXERCISE_CORRELATION_INVALID` |
| 7 | the attempted action equals the bounded action | `GRANT_EXERCISE_ACTION_OUT_OF_SCOPE` |
| 8 | the attempted resource is inside the bounded set | `GRANT_EXERCISE_RESOURCE_OUT_OF_SCOPE` |
| 9 | the attempted counterparty matches where bounded | `GRANT_EXERCISE_COUNTERPARTY_OUT_OF_SCOPE` |
| 10 | the attempted tenant matches where bounded | `GRANT_EXERCISE_ORGANIZATION_OUT_OF_SCOPE` |
| 11 | the attempted amount is at or below the ceiling, in the same unit | `GRANT_EXERCISE_AMOUNT_EXCEEDED` |

Every check is deterministic, total and fail-closed. The comparison uses the
same closed bound algebra issuance attenuates with (`compareGrantBound`), so
`incomparable` — a shape mismatch, an unparseable value, a differing currency —
is treated exactly as `broader` is.

### Absence on either side is a refusal

| grant bounds the axis | attempt states it | answer |
| --- | --- | --- |
| no | no | agrees |
| no | yes | refused — the attempt asserts an axis nothing evaluated |
| yes | no | refused — the bound cannot be proven satisfied by an absent value |
| yes | yes | the bound algebra decides |

The two middle rows are the ones that matter: a grant bounding `amount` and an
attempt stating none would otherwise execute an unbounded quantity under a
bounded permission.

### Expiry

Derived at read time from the **injected** clock, sampled **after** the
authoritative store read rather than before it. A durable store's read takes
real time, and an instant sampled before it is not the instant the grant is
being judged at: a read beginning one millisecond before `expiresAt` and
completing at `expiresAt` would otherwise report an expired grant as usable and
reach the provider. The same instant is what the outcome's `exercisedAt`
carries, so the assessment and the evidence record never disagree. No `Date.now()` anywhere in
domain logic, no sweeper, no timer, no cron, no background job — a structural
test fails the build if one appears. At `currentTime >= grant.expiresAt` the
grant is unusable; one millisecond earlier it is not. A malformed instant on
either side makes the grant unusable rather than usable-forever.

### Revocation

Visible immediately: every exercise re-reads the store, so a revocation
committed a millisecond ago is seen by the very next attempt. It is an immutable
event held beside the grant, never a mutable status on it, and it never changes
the historical authorization.

### Integrity

The trusted stored artifact is what is believed. A grant whose fields were
edited after issuance no longer matches its own digest and is refused entirely —
never repaired, and never partially honoured. A stored ceiling of 10000 where
issuance recorded 7500 does not become authority for 10000; it becomes no
authority at all.

This is integrity, not a signature. It detects fields that differ from the ones
that were digested; it is not non-repudiation and is no defence against a
privileged writer able to rewrite both. Cryptographic signing remains deferred
to signer integration.

## 8. Upstream authority is **not** re-read at exercise time

Determined from accepted architecture, not chosen for convenience.

`ADR-GOVERNED-AUTHORITY-RESERVATION.md` settles the equivalent question for the
artifact one layer up: a reservation's `expiresAt` "is set from the mandate's
own expiry. A reservation never outlives the authorization justifying it", and
"revoking a delegation or a representation **after** a mandate has issued does
not release its reservation. An issued mandate is an authorization artifact in
its own right; reservation must not smuggle a dynamic lineage dependency back
in."

A bounded grant is the same kind of thing. Its lifetime was contained by the
authority ceiling at issuance and **re-proven inside the store's commit
boundary**, so `grant.expiresAt <= authority.expiresAt` is a standing invariant
of every issued grant. The exercise-time expiry check therefore enforces the
authority ceiling transitively, and a second live read of the mandate would add
a dynamic lineage dependency the accepted architecture explicitly declines.

Where a deployment wants an authority change to end a live grant sooner, the
mechanism already exists and is explicit: **revoke the grant**. That is a
recorded, correlated, immediate act rather than an implicit consequence.

**Updated by P7 — opt-in exercise-time binding revalidation.** Without
exercise controls, everything above holds unchanged. A deployment that composes
`exerciseControls` opts into a narrower rule: every ACE grant now carries
`authorityBindingDigest`, an opaque SHA-256 commitment to the binding resolved
(and commit-proved) at issuance, and at exercise a separate, synchronous
`revalidateAuthorityBinding` resolver must answer with a binding whose canonical
digest is **exactly** that one — before the reservation, and after it against
the grant as re-read from the store. This does not
re-derive lineage or re-read the mandate for containment; it asks the host
"is the authority this grant was issued under still exactly the one that
holds?", and any difference — a new `authorityRef`, a shorter or longer
horizon, a changed justification — withholds (`EXERCISE_CONTROL_AUTHORITY_BINDING_CHANGED`).
A grant without provenance cannot be revalidated and is withheld when P7 is
composed; it executes exactly as before when P7 is not. Not atomic with the
external authority store: the binding can change after the last check. See
`docs/enterprise/AOC_EXERCISE_CONTROLS.md` §8.

## 9. Issuance wiring and the transaction boundary

A grant is issued only after: ALLOW, context evaluated, policy satisfied, every
blocking obligation satisfied, a finite issuer-proposed `expiresAt`, source
bounds derived from the evaluated action, the authority ceiling supplied where
one applies, attenuation proven, and the commit-boundary revalidation passed.
Nothing is issued speculatively.

The commit boundary is real, not commentary. `BoundedGrantStorePort.issue` takes
a **synchronous** `commitGuard` called inside the store's critical section, and
this composition's guard re-resolves the **authority binding** as well as
whatever the host revalidates about the decision. So:

```
1. measure   mandate window = T+30m, issuer proposes T+10m
2. ...       the mandate is shortened to T+6m, or revoked
3. commit    the guard sees T+6m -> refused; nothing is written
```

`resolveAuthorityBinding` is synchronous for exactly this reason: a guard that
could `await` would reintroduce the interleaving the boundary exists to prevent.
A deployment whose authority store cannot answer synchronously pre-loads the
answer first, as `acquireReservation`'s callers already do.

**Any** change to the binding refuses, not only one that would break
containment. A mandate shortened from T+30m to T+15m while the grant ends at
T+10m would still permit — but the artifact about to be written already carries
`sourceDigest` over the measured source, and the outcome would report the
measured T+30m ceiling, so committing it would record an authority state that no
longer held at the moment of the write. A different `authorityRef` with a
sufficient horizon is refused for the same reason: it is a different authority,
not a looser one. Rebuilding the artifact from the commit-time binding is not
the alternative — grant identity and digest are derived before the critical
section, so rebuilding inside it would mint a different grant than the guard was
asked about. Re-issuing against the current authority is one more call.

### The Kernel and the composition must agree on the declaration

The Kernel evaluates under *its* `GrantDeclaration` and reports the ceilings that
declaration produces; the composition recomputes them from the declaration it was
handed. A host using the custom `kernel` option can supply two different ones —
and then a Kernel configured with a five-minute maximum lifetime would report
that ceiling on the decision while issuance, reading a capability with no limit,
omitted it and minted a longer-lived grant. The two are therefore compared on
every authorization, and a difference throws
`EXECUTION_GRANT_DECLARATION_MISMATCH`: a wiring defect fails where the
deployment is composed, loudly, rather than silently widening one grant at a
time.

## 10. The provider adapter contract

```ts
interface ExecutionAdapter {
  readonly adapterId: string;
  execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult>;
}
```

The adapter receives a **validated action** and nothing else: the bounded grant
id, the subject and horizon **read from the trusted store**, the action,
resource, counterparty, tenant and amount each already proven inside a bound,
and the request/decision/execution correlation.

There is deliberately **no free-form payload, blob or opaque reference** on that
type. An adapter that dereferenced one to load the provider command would
execute data no bound covered and no assessment saw — a grant for 7500 to V123
submitting a payload for 100000 to V999, with every check passing. Resolving the
payload before assessment would make this layer read provider-specific data,
which the adapter boundary exists to prevent; integrity-binding the reference
would mean choosing a binding scheme no accepted ADR defines. The action *is*
the payload, and a structural test keeps any such channel out.

It does not receive a grant, a scope, a digest, a source authorization, a
decision, a status, reason codes, policy results, obligation state or context
facts — a structural test asserts the absence of each field. An adapter that
could re-decide would be a second decision producer, which
`ADR-AUTHORITY-CONTROL-LAYERING.md` §4 forbids; handing it a validated action
gives it nothing to do but translate and execute.

An adapter may not authorize, evaluate policy, resolve context, discharge an
obligation, issue or widen a grant, interpret an AI recommendation, or infer
missing authority. An adapter that throws becomes `ADAPTER_ERROR`; a provider
that refuses becomes `PROVIDER_REJECTED`; `PROVIDER_UNAVAILABLE` means a failure
proven to precede transmission; and an adapter that cannot know whether the
provider acted returns `unconfirmed` rather than a failure (P6). Frontera's
first concrete adapter, the Generic HTTP adapter, is documented in
[`AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md`](AOC_GENERIC_HTTP_EXECUTION_ADAPTER.md). Neither is an authorization outcome,
and `execution-failed` is a distinct status from `withheld` precisely so a
provider outage is never reported as an authority problem.

### The adapter may be a composite

`executionAdapterRouting` composes `createExecutionAdapterRegistry(...)`, whose
outer object satisfies this same port and whose inside resolves one registered
child by trusted, synchronous, **server-side** routing. This service cannot tell
the difference, and must not: which provider translates an authorized action is
a host-configuration question, decided below this port.

Nothing a caller sends chooses an adapter — there is no `adapterId`, `provider`,
`url`, `host`, `endpoint` or `credential` on any contract on this path, and an
intent carrying one is rejected. A routing failure is an infrastructure failure
(`ADAPTER_ERROR`), never a denial. See
[`AOC_EXECUTION_ADAPTER_REGISTRY.md`](AOC_EXECUTION_ADAPTER_REGISTRY.md).

### The operational interlock, when composed

`emergencyControl` is an optional, **read-only** `EmergencyControlReaderPort`.
When a deployment supplies one, this composition consults it at two of its four
lifecycle checkpoints — **inside the grant store's synchronous commit guard**,
and after the authoritative grant re-read but before the provider — and
withholds when it reports `blocked` **or** `unavailable`. The other two
checkpoints belong to the Governed Action Orchestrator (admission) and to the
registry (the adapter-scoped stop, after routing).

It is not a second decision producer, and it does not revoke: a grant withheld
by an active control is still valid and runs the moment the control is released.
Omitting it leaves every behaviour on this page byte-identical. See
[`AOC_EMERGENCY_CONTROL.md`](AOC_EMERGENCY_CONTROL.md).

## 11. Result model

```ts
ExecutionOutcome =
  | { status: 'executed';              assessment, correlation, adapterId, routedBy?, providerRef?, exercisedAt }
  | { status: 'withheld';              withheldBy: 'grant-exercise' | 'emergency-control', assessment, correlation, exercisedAt }
  | { status: 'execution-failed';      assessment, correlation, adapterId, routedBy?, reason, providerRef?, detail?, exercisedAt }   // providerRef: P11
  | { status: 'execution-unconfirmed'; assessment, correlation, adapterId, routedBy?, providerRef?, detail?, exercisedAt }        // P6; providerRef: P11
```

**P11 — provider certainty and references.** Each effect-bearing status maps to
exactly one provider-neutral certainty (`providerEffectCertaintyOf`):
`executed` → `confirmed-completed`, `execution-failed` →
`confirmed-not-completed`, `execution-unconfirmed` → `unconfirmed`. A withheld
outcome has no certainty, because no provider spoke. Any of the three may carry
the provider's opaque `providerRef`, and only when `isRecordableProviderRef`
accepts it (bounded printable ASCII, shaped like no credential, JWT, PEM block,
URL, cookie or authorization header). The reference is a correlation handle and
never proof: it never changes the status. The governed-action path records the
certainty, attribution and reference durably (see
`docs/architecture/ADR-DURABLE-MONETARY-OUTCOMES.md`); this runtime itself holds
no outcome store.

`exercisedAt` is the instant the guarding assessment was made, sampled
**before** the adapter was called. It is not the instant the provider answered.
P11 records its own `observedAt`, sampled from the injected clock after the
outcome returned.

`execution-unconfirmed` (P6) is the provider-neutral answer to "the provider was
contacted and whether the effect happened is not known" — a connection lost
after the request was sent, or a status that does not confirm the outcome. It is
not `withheld` (the adapter ran), not `execution-failed` (nothing proves the
provider did not act) and not `executed`. Authorization is untouched. It maps
from an adapter's `{ outcome: 'unconfirmed' }` result, which
`readExecutionAdapterResult` normalizes like the other two, and nothing in this
runtime retries it.

`KernelDecisionStatus` is not overloaded, extended or reused. Every case carries
the assessment, including `executed` — "why did this run?" and "why did this not
run?" are the same question asked of the same record.

## 12. No consumption model on the grant — and, since P7, an opt-in one beside it

Every accepted ADR before P7 was silent on single-use, use counters, remaining
uses, nonce consumption, replay ledgers and destruction after exercise, and
`ADR-ACCESS-LIFECYCLE.md` states the opposite for the record *about* use: usage
events are "many per `grantRef` — repeatable by design".

**P7 defines consumption, and defines it outside the grant.**
`ADR-EXERCISE-AGGREGATE-CONTROLS.md` keeps the grant immutable and puts every
reservation, settlement and release in the separate authoritative
exercise-control ledger. When a deployment composes `exerciseControls`,
repeated use is bounded by host-declared count, amount and rolling-velocity
limits admitted through a reservation before the adapter runs
(`docs/enterprise/AOC_EXERCISE_CONTROLS.md`). The grant itself still gains no
counter, and nothing below remains untrue of it.

Without exercise controls, **repeated exercise of the same valid grant is permitted and preserved**.
Execution mutates no grant state: after two exercises the stored grant is
byte-identical and no revocation appears. A structural test refuses the
vocabulary (`remainingUses`, `consume`, `decrement`, `singleUse`, a replay
ledger) so one cannot be smuggled in later without a decision and an ADR.

Recording that a grant was exercised belongs to the Evidence/Usage layer, not to
an invented consumption mechanism.

## 13. No caller-facing surface

The frozen v1 HTTP surface is untouched: 34 frozen routes, 27 endpoints,
`release/api-surface.v1.json` unmodified, no new path. There is deliberately
nothing a caller can submit — a caller must never be able to issue, extend,
revoke or exercise its own grant, so the composition is reachable from trusted
in-process host code only.

The caller self-assertion boundary is measured from the attacker's side.
`{"grantId":"trusted-grant","maxAmount":1000000}`,
`{"aoc.grant":{"status":"active"}}`,
`{"grant":{"expiresAt":"2099-01-01T00:00:00Z"}}`,
`{"grant":{"subject":"attacker"}}`, `{"grant":{"resource":"*"}}` and
`{"grant":{"revoked":false}}` each leave the assessment byte-identical — and
`aoc.grant` is stripped from the request context bag before it travels anywhere,
as it already was.

## 14. Backward compatibility

Omit `authorityControlledExecution` and nothing changes:

- no grant is issued on any path, and no bounded-grant store exists;
- `evaluate()` and `enforce()` behave identically;
- no module is registered, and `AocEnterprise.authorityControlledExecution` is
  `undefined` — which means this Host issues no grants, never that execution is
  ungoverned;
- the Governance Record carries no grant block and no `GRANT_` string;
- the frozen v1 HTTP surface gains nothing;
- `dist/src/enterprise/index.js` and `dist/src/kernel/index.js` are byte-for-byte
  unchanged, because the new public exports are type-only.

## 15. Persistence — a stated deployment limitation

The default bounded-grant store is **in memory. Grants do not survive a process
restart.**

That is acceptable for this vertical slice, and the reason is measured rather
than assumed. A grant that is gone reads as `GRANT_EXERCISE_NOT_FOUND` at the
next exercise, which withholds the adapter: losing a grant is always the closed
direction, never a widening. `ADR-ACCESS-LIFECYCLE.md` also states that "an
issued, unexercised grant is not an error state", so a grant that is never
exercised violates nothing. And this path is internal, with no caller holding a
reference across a restart.

It is still a real limitation and is stated as one:

- a grant issued before a restart cannot be exercised after it;
- a revocation recorded before a restart is lost together with the grant it
  revoked, which is closed only because the grant is lost too.

A deployment whose grants must outlive a restart supplies its own
`BoundedGrantStorePort`. `grant-store-port.ts` states the seven guarantees a
durable adapter must provide and `createSqliteAccessGrantStore` is the shape to
follow. No new schema, no new database architecture and no new store identifier
is introduced by this phase, so every durability and portability drill passes
unchanged.

## 16. Evidence correlation preserved

This is not the Evidence phase and no bundle field, disclosure-policy entry or
store schema changes here. What it does do is keep intact every identifier the
later phase will need to represent:

```
request -> decision -> obligation -> grant -> exercise -> execution result -> revocation/expiry
```

- `GrantCorrelation` is stable and exact on `requestId`, `decisionId`, `action`,
  `resourceScope`;
- the grant carries `sourceDigest` and `digest`;
- every `ExecutionOutcome` carries `requestId`, `decisionId`, `executionId`, the
  grant id, the assessment and `exercisedAt` — a stable timestamp from the
  injected clock;
- a withheld exercise is exactly as reconstructible as an executed one;
- revocation stays correlated to grant identity.

No event system, no behavioural analytics, no risk scoring and no event
warehouse is added.

## 17. No AI

No AI authorizes, issues a grant, validates a grant, bypasses revocation,
extends an expiry, decides exercise eligibility, calls a provider adapter or
mutates authority. There is no Intelligence layer in this phase, and structural
tests refuse the vocabulary and the import paths in both new modules.

## 18. Explicitly deferred

- **XRPL and any chain adapter.** No ledger, wallet, signer, transaction
  builder, sequence number, nonce or chain identifier appears anywhere; a
  structural test refuses the vocabulary. A chain adapter is a later
  implementation *of* `ExecutionAdapter`, not part of it.
- **The Evidence phase** — *Stage A delivered by P8* for the governed-action
  lifecycle: the canonical authority event stream over the committed decision,
  issuance, revocation, observed expiry, the write-ahead claim, P7 reservation
  facts and the execution outcome
  (`docs/enterprise/AOC_CANONICAL_AUTHORITY_EVENT_STREAM.md`). ACE's part is one
  write-only call after `revokeGrant` and one observer handed to the P7 gate;
  both discard failure and neither is read. Grants issued through `authorize()`
  directly by host code are outside Stage A.
- **The Intelligence layer**, and everything advisory.
- **A durable bounded-grant store** (§15).
- **A generic HTTP provider adapter.** The registry is what one will plug into;
  no `fetch(url)`, method, header, credential, redirect or DNS surface exists on
  this path today.
- **Cryptographic signing of a grant**, and any external token format.
- **Upstream authority revalidation at exercise time** (§8) — declined on the
  accepted precedent, not postponed for effort.
- **A usage/consumption model on the grant itself** (§12). The opt-in P7
  exercise-control ledger bounds repeated use beside the grant; reconciliation of
  abandoned reservations, distributed quota and exactly-once remain deferred.
- **Delegation.** No accepted ADR defines it for grants.
- **A public grant-issuance or exercise endpoint** (§13).

## Internal split for the Governed Action Orchestrator

`authorize()` is now composed from two internal halves in
`src/enterprise/execution-governance/issuance-core.ts`: `evaluate()` (the
Kernel call) and `issueFromDecision()` (grant-awareness and declaration checks,
authority binding, issuance with commit-boundary re-resolution). `authorize()`
calls them back to back, so its behaviour and signature are unchanged. The split
exists so the Governed Action Orchestrator can commit the decision to the
Governance Store *between* them and issue from the persisted decision. The core
is deliberately not exported from `execution-governance/index.ts` or any public
entrypoint, because `issueFromDecision()` accepts a decision it did not produce.
See [`AOC_GOVERNED_ACTION_ORCHESTRATOR.md`](AOC_GOVERNED_ACTION_ORCHESTRATOR.md).
