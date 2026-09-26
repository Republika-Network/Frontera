# @aoc-enterprise/access-decision

The canonical Enterprise-owned contract for **the evaluated result of a
request to access a governed resource**: `EnterpriseAccessDecision`. It
composes Soberanía Protocol's `PolicyDecision`, Enterprise's
`EnterpriseScopedAccessRequest`, and Enterprise's `EnterpriseResourceEnvelope`
-- it never duplicates, extends, or reimplements any of them.

This package is a pure data contract: no persistence, no service, no API, no
policy engine, no runtime execution, no provider SDK, no grant.

## Purpose

Access Governance needs an immutable record of *what was decided* when a
principal asked to access a governed resource: which request, against which
resource, resulting in which outcome, when, correlated with the rest of an
audit trail. `EnterpriseAccessDecision` is that record. It is produced by
something else (a policy evaluation) and consumed by something else (a
future `AccessGrant`, `UsageEvent`, or audit trail) -- it does not evaluate
policy, and it does not act on its own outcome.

## What this contract is not

- It does not execute access.
- It does not issue grants.
- It does not contact providers.
- It does not evaluate policies.

It records the immutable outcome of an evaluation that happened elsewhere.

## Ownership

- **Decision outcome vocabulary** (`'allow' | 'deny' | 'conditional'`) is
  owned by Soberanía Protocol's `PolicyDecision` (`@aoc/protocol`). This package
  never redefines it; `outcome: PolicyDecision` reads it directly.
- **The evaluated request** (`principalId`, `resource`, `requestedScope`,
  `requestedAt`, `action?`) is owned by
  `EnterpriseScopedAccessRequest` (`@aoc-enterprise/scoped-access`), itself
  composing Protocol's `ScopedAccessRequest`. This package never duplicates
  those fields; every function here that needs the requesting principal
  reads `decision.request.principalId`.
- **The governed resource** (`location`, `integrity`, `descriptor`,
  `lifecycleState`, `registeredAt`, `correlationId?`) is owned by
  `EnterpriseResourceEnvelope` (`@aoc-enterprise/resource-envelope`), itself
  composing Protocol's `ResourceRef`. This package never duplicates those
  fields; every function here that needs the governed resource reads
  `decision.resource`.
- **Everything else on `EnterpriseAccessDecision`** -- `evaluatedAt`,
  `correlationId`, `reason?`, `policyEvaluationRef?`, `evidenceRefs?` -- is
  owned by Frontera Systems (`@aoc-enterprise/access-decision`), because it is
  metadata about the evaluation event itself, not part of the request or the
  resource.

## Why composition, not extension

`EnterpriseAccessDecision` is not "a request with extra properties" or "a
resource with extra properties" -- it is a description *about* a completed
evaluation of a request against a resource. Following the precedent set by
`EnterpriseResourceEnvelope` (which composes `ResourceRef` by reference
rather than extending it, see `docs/architecture/ADR-RESOURCE-ENVELOPE.md`):

```ts
interface EnterpriseAccessDecision {
  readonly request: EnterpriseScopedAccessRequest;
  readonly resource: EnterpriseResourceEnvelope;
  // ... outcome, evaluatedAt, correlationId, ...
}
```

Reasons:

1. **The decision is not "a request with a verdict bolted on."** A request
   answers "what is being asked for?"; a decision answers "what happened
   when that request was evaluated?" Those are different questions with
   different lifecycles -- a request exists before it is evaluated; a
   decision exists only after.
2. **It composes cleanly with any future shape either composed contract
   takes.** If `EnterpriseScopedAccessRequest` or `EnterpriseResourceEnvelope`
   ever gains a field, this contract inherits it automatically through the
   `request`/`resource` properties.
3. **It keeps "no duplicated identity" mechanically checkable**, the same
   way `EnterpriseResourceEnvelope` does: `principalId` only exists on
   `decision.request`; resource identity only exists on
   `decision.request.resource` and `decision.resource.resource`. TypeScript's
   excess-property checking on object literals catches an accidental
   top-level `principalId` at compile time (see the negative tests).

## Why the request and the resource envelope can name two `ResourceRef`s

`EnterpriseScopedAccessRequest` already carries `resource: ResourceRef`
(inherited from Protocol's `ScopedAccessRequest`) -- the resource *as asked
for*. `EnterpriseResourceEnvelope` separately carries `resource: ResourceRef`
-- the resource *as governed* (with location, integrity, lifecycle).
`EnterpriseAccessDecision` composes both rather than picking one, because a
decision genuinely needs both views: what was requested, and the full
governance record of what that request resolved to. `validateEnterpriseAccessDecision`
enforces that the two agree on identity (`kind`, `id`, `tenantId`) via
`RESOURCE_IDENTITY_MISMATCH` -- an impossible combination, not a duplicated
identity mechanism, since both still delegate to the one canonical
`resourceRefIdentityEquals` from `@aoc-enterprise/resource-envelope`.

## Decision semantics

`outcome: PolicyDecision` reuses Soberanía Protocol's existing tri-state decision
vocabulary (`'allow' | 'deny' | 'conditional'`), already canonical at the
Protocol level (`PolicyDecisionResult.decision` in `@aoc/protocol/adapters`)
and protected from redefinition by `scripts/check-protocol-consumption.mjs`'s
`protectedSymbols` list.

A second, superficially similar type exists in the repository:
`EnterprisePolicyDecision` (`'allow' | 'deny' | 'allow-with-obligations'`,
`@aoc-enterprise/policy-runtime`). It was **not** reused here, deliberately:

| | `PolicyDecision` (`@aoc/protocol`) | `EnterprisePolicyDecision` (`@aoc-enterprise/policy-runtime`) |
| --- | --- | --- |
| Scope | Protocol-wide, provider-neutral outcome vocabulary | One specific policy-evaluation orchestration engine's response shape |
| Carries | Nothing beyond the three literal states | `obligations` -- a list of *runtime instructions* to carry out (e.g. redact a field, notify a party) |
| Fit for an immutable record | Yes -- describes a state, nothing else | No -- `obligations` is execution-shaped, and an `AccessDecision` must never carry anything that looks like an instruction to execute |

Reusing `EnterprisePolicyDecision` would pull an execution-adjacent concept
(`obligations`) into a contract whose entire purpose is to *not* be
executable. `policyEvaluationRef` (see below) is how this contract points at
a `EnterprisePolicyEvaluationResponse` (or any other policy engine's output)
without embedding its shape.

No third decision vocabulary was invented. This is the minimum required
model: a decision that cannot represent "allow," "deny," or "conditional" is
not evaluating access; a fourth state was not justified by anything in this
sequence's scope.

## References, not embeddings

`policyEvaluationRef?: CanonicalId` and `evidenceRefs?: readonly CanonicalId[]`
are opaque pointers -- an id a policy engine or evidence store assigned to
its own record (e.g. an `EnterprisePolicyEvaluationResponse.decisionId`, a
`CanonicalEvidence.id`) -- never the referenced object itself. This is
intentional: `EnterpriseAccessDecision` does not know or assume the shape of
any policy engine's output or any evidence bundle. It records that an
evaluation and some evidence existed and how to find them later; it does not
duplicate them.

## Explicit non-responsibilities

`EnterpriseAccessDecision` never carries, and by design cannot carry
(enforced at compile time -- see `__tests__/enterprise-access-decision.test.ts`):

- API keys, provider credentials, bearer tokens, access keys, JWTs,
  authorization headers
- URLs, download links, temporary/signed grants
- Pinata-shaped or S3-shaped (or any other provider-specific) objects
- runtime clients or provider SDK instances/types
- grant identifiers or any other `AccessGrant` field (approval state,
  revocation state, grantee, scope) -- those belong to a future
  `AccessGrant`, which will *reference* a decision, not extend it
- a policy engine, rule set, or any form of permission evaluation logic

## Relationship diagram

```text
┌───────────────────────────────┐    ┌────────────────────────────────────┐
│ @aoc/protocol                  │    │ @aoc/protocol                        │
│ ScopedAccessRequest             │    │ PolicyDecision                        │
│ (principalId, resource,         │    │ ('allow' | 'deny' | 'conditional')    │
│  requestedScope, requestedAt)   │    └──────────────────┬─────────────────┘
└────────────────┬────────────────┘                       │
                  │ extended by                            │ reused directly,
                  ▼                                         │ never redefined
┌───────────────────────────────┐                          │
│ @aoc-enterprise/scoped-access   │                          │
│ EnterpriseScopedAccessRequest   │                          │
│ (+ action?)                     │                          │
└────────────────┬────────────────┘                          │
                  │ composed by reference (request: ...)      │
                  ▼                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/access-decision                                           │
│                                                                             │
│ EnterpriseAccessDecision                                                   │
│   request: EnterpriseScopedAccessRequest   -- what was asked for          │
│   resource: EnterpriseResourceEnvelope     -- what was governed           │
│   outcome: PolicyDecision                  -- what was decided            │
│   evaluatedAt / correlationId / reason?                                   │
│   policyEvaluationRef?                     -- points at a policy record   │
│   evidenceRefs?                            -- points at evidence records  │
└──────────────────┬──────────────────────────────────┬────────────────────┘
                    ▲                                  │
                    │ composed by reference             │ future, not
┌───────────────────┴───────────────┐                  │ implemented here
│ @aoc-enterprise/resource-envelope   │                  ▼
│ EnterpriseResourceEnvelope           │      ┌───────────────────────────┐
│ (resource: ResourceRef, location,     │      │ Policy evaluation record   │
│  integrity?, lifecycleState, ...)      │      │ (e.g. EnterprisePolicy-    │
└────────────────────────────────────┘      │  EvaluationResponse) and    │
                                              │ evidence record(s) (e.g.   │
                                              │ CanonicalEvidence) -- both │
                                              │ referenced by id, never    │
                                              │ embedded                  │
                                              └───────────────────────────┘
```

## Relationship to future `AccessGrant`

A future `AccessGrant` contract is where approval state, revocation state,
grantee, and scope will live. It will reference an `EnterpriseAccessDecision`
(the decision that authorized issuing the grant) the same way it will
reference an `EnterpriseResourceEnvelope`'s `resource` for identity -- this
package does not implement or assume that contract's shape.

## Relationship to future `Audit`

A future audit trail entry will correlate back to a decision's
`correlationId` and, transitively, to the resource envelope's own
`correlationId` -- the same correlation pattern
`AuditEventEnvelope.correlationId` already establishes in `@aoc/protocol`.
Not implemented here.

## Relationship to future `UsageEvent`

A future `UsageEvent` contract would record that access actually occurred,
correlating back to the `EnterpriseAccessDecision` that authorized it (via
`correlationId`) and to the underlying `EnterpriseResourceEnvelope.resource`.
Not implemented here.

## Relationship to future provider adapters

No provider adapter is implemented or assumed by this contract.
`EnterpriseAccessDecision` never mentions a provider by name (see "Explicit
non-responsibilities"); a future adapter would consume an `AccessGrant`
(itself downstream of an `AccessDecision`) to actually reach a resource --
this contract records only that a decision was made, never how to act on it.

## API

- `EnterpriseAccessDecision` -- the contract.
- `enterpriseAccessDecisionIdentityEquals(a, b)` -- identity equality,
  derived from resource identity, principal, and evaluation instant only.
- `enterpriseAccessDecisionEquals(a, b)` -- full structural equality;
  delegates the resource half to `enterpriseResourceEnvelopeEquals`.
- `validateEnterpriseAccessDecision(candidate)` -- internal-consistency
  validation only (see "Explicit non-responsibilities"); delegates
  resource-envelope shape validation to `validateEnterpriseResourceEnvelope`.
- `serializeEnterpriseAccessDecision(decision)` /
  `deserializeEnterpriseAccessDecision(candidate)` -- deterministic,
  round-trip-safe (de)serialization; delegates the resource half to
  `serializeEnterpriseResourceEnvelope` / `deserializeEnterpriseResourceEnvelope`.
- `EnterpriseAccessDecisionValidationError` -- thrown by
  `deserializeEnterpriseAccessDecision` on invalid input.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/access-decision
npm test --workspace @aoc-enterprise/access-decision
```
