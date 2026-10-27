# Kernel external authorization port (deny-only)

Status: **Kernel port only** (FRONTERA-SOBE-PILOT-01B). The port is optional and nothing configures
it: no Host, composition root, deployment or Soberanía runtime is wired to it, and no Frontera source
imports a Soberanía package. Wiring a Soberanía authorization runtime behind it is FRONTERA-SOBE-PILOT-01C.

## Contract

`AocKernelOptions.externalAuthorization = { provider, timeoutMs }`, where `provider` is an
`ExternalAuthorizationProvider` (`src/kernel/contracts/ports.ts`):

```ts
authorize(input: ExternalAuthorizationInput): Promise<{ decision: 'allow' } | { decision: 'deny' }>
```

- **Input** is built by the Kernel and frozen: request id, declared actor and trust domain, organization,
  action type and capability, resource scope, target type and id, `at` (the Kernel clock's instant, never
  the requester's `requestedAt`), and an `AbortSignal`. No request object, context bag or caller time
  crosses the port.
- **Response** must be a plain object whose only own key is `decision`, a data property equal to `'allow'`
  or `'deny'`. Anything else is malformed — including an `allow` carrying a scope, grant or identity.
- **`timeoutMs`** is required: an integer in [1, 30000]. A missing provider, a provider without
  `authorize()` or an out-of-range bound is a `KernelConfigurationError` when the Kernel is constructed.

## Invariants

| Kernel outcome | External answer | Final |
| --- | --- | --- |
| `allowed` | `allow` within the bound | `allowed`, unchanged (the external step is only recorded) |
| `allowed` | `deny` | `denied`, `EXTERNAL_AUTHORIZATION_DENIED` |
| `allowed` | throws or rejects | `denied`, `EXTERNAL_AUTHORIZATION_UNAVAILABLE` |
| `allowed` | no answer within the bound | `denied`, `EXTERNAL_AUTHORIZATION_TIMEOUT` |
| `allowed` | malformed | `denied`, `EXTERNAL_AUTHORIZATION_INVALID_RESPONSE` |
| `denied`, `approval_required`, `indeterminate` | anything | unchanged, with the Kernel's own reasons |

- The Kernel remains the only decision-maker. The port can turn `allowed` into `denied` and nothing else:
  it cannot rescue a denial, clear an `approval_required`, add a permission or widen a grant.
- When the bound elapses the outcome is fixed as `timeout` and the signal is aborted. The pending call
  settles into a handler that discards it, so a late `allow` is never read and a late rejection is never
  unhandled.
- On a narrowing the external code leads `reasonCodes` and the Kernel's codes follow, as the
  governed-authority step does; `summary` is a fixed sentence per outcome. Nothing the external authority
  says — message, reason, payload, timing — reaches the result.
- `result.externalAuthorization = { performed, outcome, narrowed, reasonCode? }`, and one final trace step
  `external_authorization` (`passed`, `failed` or `skipped`; the code, or none; no timestamps or metadata).
- **Absent**, behaviour is byte-identical to before: no call, no field, no trace step.

## Where it runs

- **`evaluate()`**: after every narrowing step of the Kernel's own (engine chain, governed authority,
  context), and only when the result is `allowed`; otherwise it is recorded as `not_consulted` and the
  port is not called. Before the obligation and grant steps, so a vetoed decision is reported
  grant-`ineligible` like any denial.
- **`enforce()`**: `guard.enforce()` decides and invokes the executor in one call, so the port is asked
  before it — after the Kernel's own pre-execution refusals (governed authority, context), which therefore
  never reach the port. A veto takes the existing preflight-only path an unmet obligation takes: the real
  decision is produced, folded exactly as in `evaluate()` (a Kernel denial keeps its own reasons), and the
  executor is never reached. That path claims the idempotency key exactly as the other non-executing
  `enforce()` paths already do. With no veto, `guard.enforce()` runs unchanged, so commit-before-execution,
  idempotency and grant behaviour are as before.

## Requirements carried into FRONTERA-SOBE-PILOT-01C

1. **Declaration gap.** `@aoc-runtime/authorization-runtime`'s declarations import types from the excluded
   `@aoc-runtime/audit-runtime` and `@aoc-runtime/trust-registry-runtime`. The adapter must compile against
   them without `skipLibCheck` hiding the gap — by a declaration fix in Soberanía and a repack, or by typed
   local declarations for exactly those two imports — never with those types silently `any`.
2. **One server-derived clock.** The adapter must pass the port input's `at` as both the consent `at` and
   the capability `now`, and never fall back to the wall clock.
3. **Provider exceptions.** A policy, capability or consent provider that throws makes the runtime's
   `evaluate()` reject. The port already maps a rejection to `EXTERNAL_AUTHORIZATION_UNAVAILABLE`; the
   adapter must not catch it into an allow.
4. **Production dependency closure.** The runtime packages are vendored test artifacts today. They must
   enter Frontera's real dependency graph with the approved closure only (`@aoc/protocol/canonical` stays
   an internal dependency), and the runtime-lock and boundary checks must cover the installed graph.
5. **Trusted providers and identity.** Real ownership, consent, capability, policy and governance providers
   and their trusted keys must come from operator configuration, and the declared actor must map to a
   Soberanía subject through trusted configuration, not through request fields.
