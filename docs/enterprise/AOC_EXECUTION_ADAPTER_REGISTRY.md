# AOC Execution Adapter Registry

**Status:** internal capability. Opt-in at composition. No customer HTTP route,
no SDK method, no caller-facing selector.

> **Which trusted provider adapter translates this already-authorized action —
> and who gets to decide that?**

The answer to the second half is: **the host, on the server, from fields that
were already proven inside a bound.** Never the caller.

---

## 1. What it is

A **composite** `ExecutionAdapter`. Its outer object satisfies the canonical
port, so it stands exactly where a single provider adapter stood; inside, it
resolves one registered child and invokes that child.

```
GrantExecutionService
  ↓  ExecutionAdapter.execute(ValidatedExecutionAction)
ExecutionAdapterRegistry                       ← satisfies the port itself
  ↓  selectAdapter(action)                     trusted, synchronous, host-owned
  ↓  emergency-control check, with the selected adapterId
  ↓  exactly one registered ExecutionAdapter
provider
```

The registry receives **only** a `ValidatedExecutionAction` — an action that has
already passed the authoritative bounded-grant re-read and the containment
assessment. There is no way to enter it earlier.

---

## 2. Routing is not authorization

The registry chooses **where** an already-authorized action is translated. It
never chooses **whether** it is authorized.

It holds no Kernel, no policy evaluator, no grant, no grant store, no Governance
Store, no customer authentication and no HTTP type; it reads no clock and
re-derives nothing. `no-bypass-effect-paths.test.ts` and
`security-invariants.test.ts` assert the absence of each, and pin its import list
to exactly two specifiers: the execution runtime's own domain, and the
emergency-control read port.

Its inputs are:

- the `ValidatedExecutionAction`,
- a trusted selector,
- trusted registered adapters,
- optionally an `EmergencyControlReaderPort`.

Nothing more.

---

## 3. The caller never chooses

There is no `adapterId`, `provider`, `destination`, `url`, `host`, `endpoint`,
`credential` or provider body on `GovernedActionIntent`, on
`KernelEvaluationRequest`, on `GrantExerciseRequest` or on
`ValidatedExecutionAction` — and this phase deliberately **did not add one**.

Adding `adapterId` to the intent would have made routing trivial and would have
let caller-controlled material choose infrastructure. `validateGovernedActionIntent`
is closed: an intent carrying any of those keys is **rejected**, not
sanitized, and `emergency-control-composition.test.ts` walks the list.

Selection is made from fields the grant already contained:

```ts
type ExecutionAdapterSelector = (action: ValidatedExecutionAction) => string | undefined;
```

— `action`, `resource`, `organization`, `subject`, `counterparty`, `amount`,
`notAfter`, `boundedGrantId`, `correlation`. A caller can therefore influence
*which* provider runs only by asking for a different action or resource, which
is the same material the Kernel decided on and the grant contained.

The selector is **synchronous**, so routing cannot introduce a network hop, a
cache with its own staleness, or an `await` between the assessment and the
provider call. Async, network-backed routing is not part of this phase.

---

## 4. Construct, validate, freeze

There is no `register` / `unregister` surface. Membership is settled at
composition and cannot change while traffic flows, so "which adapter can run" is
a property of the deployment rather than of whatever most recently mutated a
map. The returned object is frozen and exposes exactly `adapterId` and
`execute`.

Composition throws `ExecutionAdapterRegistryError` for:

| Code | Refused because |
|---|---|
| `EXECUTION_ADAPTER_REGISTRY_EMPTY` | a registry that can route nothing would fail every governed action at the provider boundary |
| `EXECUTION_ADAPTER_MALFORMED` | a blank id, a missing `execute`, a non-object |
| `EXECUTION_ADAPTER_ID_DUPLICATE` | routing would resolve to whichever was registered last |
| `EXECUTION_ADAPTER_REGISTRY_RECURSIVE` | a registry inside a registry, or an adapter claiming the registry's own id — one routing decision must resolve to one provider |
| `EXECUTION_ADAPTER_SELECTOR_INVALID` | no trusted selector |

Recursion is detected through a module-private `WeakSet` of registries this
factory produced, rather than a marker property, because a marker on the object
is something a caller could also set.

The composition root additionally refuses a deployment that states **both**
`executionAdapter` and `executionAdapterRouting`, or neither
(`EXECUTION_ADAPTER_COMPOSITION_INVALID`). Which provider receives a real-world
effect is not a question to answer by precedence.

---

## 5. Exactly one child, at most once

- The selector returns at most one identity.
- An unknown id, `undefined`, or a selector that throws invokes **no child**.
- The child receives the `ValidatedExecutionAction` **unchanged** — nothing
  widens or substitutes `action`, `resource`, `counterparty`, `organization`,
  `amount` or `notAfter`, and no provider material is injected on the way down.
  `execution-adapter-registry.test.ts` proves this by comparing the object the
  child saw with the object a directly-composed adapter saw for the same
  exercise: they are deep-equal.

### Unresolved route

Reported as an **infrastructure failure** in the vocabulary the execution
boundary already owns:

```
{ outcome: 'failed', reason: 'ADAPTER_ERROR', detail: 'No execution adapter is configured for this action.' }
```

which surfaces as `execution_failed` / `ADAPTER_ERROR`. It is deliberately:

- **not** a Kernel denial — nothing about the authorization changed, and the
  assessment that permitted the action still says `usable`;
- **not** a new reason-code vocabulary — `ADAPTER_ERROR` is semantically
  sufficient and a second vocabulary would be a second thing to keep disjoint;
- **not** a fallback to an arbitrary provider. "Whichever one was registered
  first" is not a routing decision anybody made.

A host that genuinely wants a default configures its *selector* to return one.

---

## 6. The adapter-scoped emergency control

The execution runtime cannot know the selected child until routing has resolved
it, so the adapter-scoped stop belongs here. After selection and before
invocation, the registry reads the interlock with the **child's** `adapterId`
plus the organization, actor and resource already on the action.

Blocked or unreadable ⇒ the child is not called, and the withholding is
propagated as one typed signal, `EmergencyControlWithheldError`, which
`GrantExecutionService` maps onto `withheldBy: 'emergency-control'`.

Why a signal rather than a third `ExecutionAdapterResult` case: widening that
result type would let **every** adapter implementation, including ones a host
writes, claim an emergency stop. Only trusted code holding a reader can
construct this class, and the execution service recognises this type and no
other — an ordinary adapter throw stays `ADAPTER_ERROR`.

A stop here is never reported as `PROVIDER_REJECTED`: the provider was never
contacted. See `AOC_EMERGENCY_CONTROL.md` §2.

A registry composed without a reader enforces no adapter-scoped stop, and says
so by behaving exactly as it did before.

---

## 7. No-bypass accounting

`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §7.1 enumerates every holder of
the `ExecutionAdapter` port, and §17 classifies EP-011. Since this phase there
are **two** invocation sites rather than one:

1. `grant-execution-service.ts` — the gate, after the authoritative store read
   and the usable-assessment gate;
2. `execution-adapter-registry.ts` — the composite, after routing and after the
   emergency-control check.

`GrantExecutionService → registry → child adapter` is **one composite provider
boundary**, not a second way in, and that is a proven property rather than a
claim: the structural suites pin both call sites, pin that the registry is
reachable only through the gate, and pin the ordering inside each.

No new effect path was added. The registry introduces no entry point, no egress
site and no provider; the children a deployment registers are the same trusted
host code a single `executionAdapter` always was. The effect-path inventory's
count is therefore unchanged.

**The host-trust caveat is unchanged and is not weakened here.** A composing host
that retains a raw adapter reference remains inside the trusted computing base
and can call that adapter directly, bypassing the gate, the registry and every
emergency control. Routing constrains what *Frontera* does, not what the process
can do (`SEC-TRUST-001`, `SEC-TRUST-004`).

---

## 8. Composition

```ts
// One provider — unchanged, and still valid.
authorityControlledExecution: {
  grantCapability,
  executionAdapter: myAdapter,
  resolveAuthorityBinding,
}

// Several providers, routed server-side.
authorityControlledExecution: {
  grantCapability,
  executionAdapterRouting: {
    adapters: [payoutsAdapter, ledgerAdapter],
    selectAdapter: (action) => (action.action === 'payment.send' ? 'payouts' : 'ledger'),
  },
  resolveAuthorityBinding,
}
```

The composition root builds the registry rather than the host, so the registry
receives the **same** emergency-control reader the other three checkpoints use.
A host that builds its own registry and passes it as `executionAdapter` must
pass its own reader into it.

The ACE module reports the composite's `adapterId`, so a deployment's health
names the boundary the Host holds rather than one of the children behind it.

---

## 9. Out of scope in this phase

- **No generic HTTP provider adapter.** No `fetch(url)`, method, headers,
  credential, redirect or DNS surface appears here. The registry is what such an
  adapter will plug into.
- **No XRPL, wallet, signer, transaction builder, seed or key.** Provider-neutral
  throughout.
- **No async, network-backed routing.**
- **No customer adapter selector**, in the API or the SDK.
