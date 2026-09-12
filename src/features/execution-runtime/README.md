# Execution Runtime

The provider-neutral boundary between an issued bounded grant (layer **E**) and
an external action.

> **Is this specific presented bounded grant still valid and sufficient for this
> specific action, right now — and if so, what does the provider do?**

That is the only question this module answers. It does not authorize anything,
it does not issue or narrow a grant, and it cannot be made to:
`tests/execution-layer-boundaries.test.ts` fails the build if a decision status,
a policy effect, an obligation discharge, a grant mint or an AI dependency ever
appears here.

The full design — authorization versus exercise, the production composition, the
authority-binding model, persistence and what is deferred — is
`docs/enterprise/AOC_AUTHORITY_CONTROLLED_EXECUTION.md`. This file covers what
lives in *this* module.

## The one invariant

> **NO ADAPTER CALL WITHOUT A USABLE EXERCISE ASSESSMENT.**

Not "the assessment said no" — **the adapter was not called**. A refusal that
still reached a provider would have failed at the only thing this module exists
to guarantee, so the suite counts invocations rather than inspecting verdicts:
`0` for every blocked row, `1` for a valid exercise, `2` for two valid exercises
of the same grant.

## Where it sits

```
Authority / Policy / Context
        ↓
    Obligations
        ↓
      Grants          ← src/features/grant-runtime
        ↓
  execution path      ← here
        ↓
   ExecutionAdapter   ← a provider implementation, outside this module
```

It reads layer E and nothing above it. It imports the grant runtime and nothing
else but its own files — no Kernel, no policy runtime, no enforcement engine, no
context runtime, no obligation runtime, no Enterprise host, no Evidence, no
Intelligence, and no `node:fs`/`node:http`/database client of its own. Asserted
against the TypeScript sources, in the convention
`grant-layer-boundaries.test.ts` set.

It is also the **only** place an executor, an adapter or a provider may be
named. The grant runtime is structurally forbidden from naming any of them,
precisely so that this module is where they appear.

## Two functions and a service

`assessBoundedGrantExercise` — synchronous, pure, total. Takes a trusted grant,
its revocation if one stands, the attempted action and an **injected** instant,
and answers `usable` with every failing reason. It is synchronous on purpose: a
pure assessment is what lets the same logic run inside a commit boundary later
without reintroducing the interleaving a synchronous `commitGuard` exists to
prevent.

`createGrantExecutionService` — reads the authoritative store on **every**
attempt, assesses, and calls the adapter only on a usable assessment. There is
no cached grant, no caller-supplied grant and no fast path that skips the read,
so a revocation committed a millisecond ago is visible to the very next
exercise. `assess()` answers without acting; `exercise()` acts.

## The request carries a reference, never a grant

`GrantExerciseRequest.boundedGrantId` is the whole of what a caller may say
about the grant. There is deliberately no field for a grant object, a scope, an
expiry, a revocation status, a digest or a grant-claimed subject —
`ADR-ACCESS-GRANT.md` and the grant runtime's "No token format" both settle that
a bounded grant "is an internal, typed record held by a trusted store; a caller
never holds one and therefore never presents one", and no accepted ADR has since
defined a self-authenticating serialized form.

So the tampering case has no shape to arrive in. A caller sending
`{"grantId":"trusted-grant","maxAmount":1000000}` has sent one field this type
reads and one that does not exist. `tests/execution-determinism.test.ts` casts
past the type system anyway — the strongest form of the attack available — and
asserts the assessment comes back byte-identical for eleven such payloads.

## The checks

Every one deterministic, total, fail-closed, and all of them reported rather
than only the first. A grant that is revoked, expired *and* used for the wrong
resource is all three, and an operator asking "why can this not be used"
deserves all three answers.

| check | reason code |
| --- | --- |
| the request states what a comparison needs | `GRANT_EXERCISE_REQUEST_MALFORMED` |
| the store holds the grant | `GRANT_EXERCISE_NOT_FOUND` |
| its digest still matches its fields | `GRANT_EXERCISE_INTEGRITY_INVALID` |
| not at or past `expiresAt` | `GRANT_EXERCISE_EXPIRED` |
| no revocation stands | `GRANT_EXERCISE_REVOKED` |
| the attempting party is the holder | `GRANT_EXERCISE_SUBJECT_MISMATCH` |
| the correlation names the same authorization | `GRANT_EXERCISE_CORRELATION_INVALID` |
| action / resource / counterparty / organization / amount | `GRANT_EXERCISE_*_OUT_OF_SCOPE`, `GRANT_EXERCISE_AMOUNT_EXCEEDED` |

Scope containment uses `compareGrantBound` — the same closed algebra issuance
attenuates with — so `incomparable` (a shape mismatch, an unparseable value, a
differing currency) is treated exactly as `broader` is. A requested `'*'` fails
because it is a different identity value, not because a wildcard rule exists.

### Absence on either side is a refusal

| grant bounds it | attempt states it | answer |
| --- | --- | --- |
| no | no | agrees |
| no | yes | refused |
| yes | no | refused |
| yes | yes | the algebra decides |

The middle rows are the ones that matter. A grant bounding `amount` and an
attempt stating none would otherwise execute an unbounded quantity under a
bounded permission; an attempt naming a counterparty the grant never bounded
would otherwise execute against a party nothing evaluated. This is the posture
`attenuateGrantScope` already takes one layer up, stated once here so the two
layers cannot drift apart.

## A fourth reason-code vocabulary

`GRANT_EXERCISE_REASON_CODES` is a separate constant, in a separate file, with a
separate type, and every value carries the `GRANT_EXERCISE_` prefix.

| vocabulary | answers |
| --- | --- |
| `AOC_KERNEL_REASON_CODES` | what did authority and policy conclude? |
| `AOC_KERNEL_EXERCISE_REASON_CODES` | is a condition on an authorized action met? |
| `GRANT_REASON_CODES` | may a grant be *issued*, and does an issued one stand? |
| `GRANT_EXERCISE_REASON_CODES` | is this grant sufficient for this action now? |

`tests/execution-layer-boundaries.test.ts` asserts the four are pairwise
disjoint. Keeping the last two in one union would collapse the distinction
issuance and exercise exist to keep: "this grant could not be issued" and "this
grant cannot cover this action" send an operator to different places.

## No ambient anything

No `Date.now()`, no `new Date()`, no `performance.now` — the instant is injected,
and a structural test fails the build if an ambient clock appears. No
`randomUUID`, no `Math.random`, no `randomBytes`, no `nextId`. No `eval`, no
`new Function`, no dynamic import. No `setTimeout`, no `setInterval`, no cron, no
sweeper, no scheduler, no queue and no worker: expiry and revocation are derived
at read time, so correctness never depends on a job having run.

## No consumption model

No counter, no `remainingUses`, no single-use flag, no nonce ledger, no
decrement, no destruction after exercise — and a structural test refuses the
vocabulary so one cannot be added later without a decision and an ADR.

Every accepted ADR is silent on consumption, and `ADR-ACCESS-LIFECYCLE.md` says
the opposite for the record *about* use: usage events are "many per `grantRef` —
repeatable by design". So repeated exercise of one valid grant is permitted, and
the suite asserts the stored grant is byte-identical afterwards.

## The adapter contract

```ts
interface ExecutionAdapter {
  readonly adapterId: string;
  execute(action: ValidatedExecutionAction): Promise<ExecutionAdapterResult>;
}
```

`ValidatedExecutionAction` carries the grant id, the subject and horizon **read
from the trusted store**, the action/resource/counterparty/organization/amount
each already proven inside a bound, and the request/decision/execution
correlation. It carries no grant, scope, digest, source authorization, decision,
status, reason code, policy result, obligation state or context fact — a test
asserts the absence of each, because an adapter that could re-decide would be a
second decision producer.

It also carries **no free-form payload, blob or opaque reference**, and a
structural test keeps it that way. An earlier revision had one, and it was a
hole: an adapter that dereferenced such a handle to load the provider command
would execute data no bound covered and no assessment saw — a grant for 7500 to
V123 submitting a payload for 100000 to V999, with all twelve checks passing on
the way. Resolving the payload here would make this layer read provider-specific
data, which is what the adapter boundary exists to prevent; integrity-binding
the reference would mean choosing a binding scheme no accepted ADR defines. So
the action *is* the payload, and a later ADR that genuinely needs an
out-of-band one must arrive with the binding that makes it safe.

An adapter that throws becomes `ADAPTER_ERROR` rather than escaping, and a
provider that refuses becomes `PROVIDER_REJECTED`. Neither is an authorization
outcome: `execution-failed` is a distinct status from `withheld` so a provider
outage is never reported as an authority problem.

## Provider-neutral, and no chain

No ledger, wallet, mnemonic, private key, signed transaction, sequence number,
nonce, gas limit or chain identifier appears anywhere, and no specific provider
is named. A structural test refuses all of it. A chain adapter is a later
implementation *of* this port; nothing here anticipates one.

It also locks itself to no token standard — no JWT, macaroon, UCAN, OAuth,
bearer token or signed URL — for the same reason the grant runtime does not: a
caller never holds a grant, so it never presents one.

## The fake adapter lives under `tests/`

`createRecordingExecutionAdapter` is a test fixture, not a production export. A
no-op adapter shipped as production code is an execution path nobody chose, and
a recorder proves the boundary more sharply than a real provider would: what is
under test is the invocation count.
