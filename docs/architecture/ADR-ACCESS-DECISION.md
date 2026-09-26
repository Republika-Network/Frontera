# ADR: Canonical Access Decision (R004.E)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.C (`ResourceRef` canonicality conclusion), R004.D
  (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  `packages/scoped-access/src/enterprise-scoped-access-request.ts` (the
  existing Enterprise-wraps-Protocol composition pattern this contract
  follows), `packages/policy-runtime/src/contracts.ts` (the policy
  evaluation engine this contract references but does not embed)

## Context

R004.D established `EnterpriseResourceEnvelope` as the canonical Enterprise
representation of a governed external resource, composing Protocol's
`ResourceRef` by reference. Access Governance now needs a canonical way to
record *the result of evaluating a request against that resource*: who
asked, for what, against which resource, what was decided, when, and how to
correlate that decision with the rest of an audit trail -- without this
contract performing the evaluation itself, contacting a provider, or issuing
a grant.

No such contract exists today. `ScopedAccessRequest` (`@aoc/protocol`)
describes a request; `EnterpriseResourceEnvelope` describes a resource;
`EnterprisePolicyEvaluationResponse` (`@aoc-enterprise/policy-runtime`)
describes one specific orchestration engine's evaluation output. None of
these is "the immutable record that a request against a resource was
evaluated to a particular outcome" -- that is a distinct, provider-neutral
concept this sequence introduces.

R004.C and R004.D's conclusions, treated as authoritative for this sequence:

- `ResourceRef` is the canonical identity primitive; it must not be
  duplicated.
- `EnterpriseResourceEnvelope` is the canonical Enterprise representation of
  a governed resource; a new contract needing to represent "the resource"
  must compose with it, not with a bare `ResourceRef` or a new ad hoc shape.
- Enterprise composes Protocol contracts by reference when the new fields
  describe something *about* the composed value (`EnterpriseResourceEnvelope`
  wrapping `ResourceRef`), and extends them when the new field is additive to
  the *same* value (`EnterpriseScopedAccessRequest` extending
  `ScopedAccessRequest`). Both precedents apply here, unchanged.

## Decision

Create `EnterpriseAccessDecision` in a new package,
`@aoc-enterprise/access-decision` (`packages/access-decision`):

- **Composes `EnterpriseScopedAccessRequest` and `EnterpriseResourceEnvelope`
  by reference**, not extension: `request: EnterpriseScopedAccessRequest` and
  `resource: EnterpriseResourceEnvelope` are properties, not supertypes. A
  decision is not "a request with a verdict" or "a resource with a verdict"
  -- it is a description about a completed evaluation involving both.
- **Reuses Soberanía Protocol's `PolicyDecision`** (`'allow' | 'deny' |
  'conditional'`) directly for `outcome`, rather than inventing a new enum or
  reusing the Enterprise-local `EnterprisePolicyDecision`
  (`@aoc-enterprise/policy-runtime`), which carries `obligations` --
  execution-shaped state that must never appear on an immutable evaluation
  record. See the package README's "Decision semantics" section for the full
  comparison.
- **Never duplicates identity.** The requesting principal exists only at
  `decision.request.principalId`; resource identity exists only at
  `decision.request.resource` and `decision.resource.resource`. Enforced at
  compile time via TypeScript excess-property checking in the negative test
  suite.
- **Validates the one genuine cross-field consistency requirement**: that
  `request.resource` and `resource.resource` refer to the same `ResourceRef`
  identity (`RESOURCE_IDENTITY_MISMATCH`), delegating the comparison to the
  already-canonical `resourceRefIdentityEquals` from
  `@aoc-enterprise/resource-envelope` -- never a second identity algorithm.
- **References, never embeds, policy evaluation and evidence.**
  `policyEvaluationRef?: CanonicalId` and `evidenceRefs?: readonly
  CanonicalId[]` are opaque pointers to records owned elsewhere (a policy
  engine's response, an evidence store's entries). This contract does not
  assume either's shape and does not evaluate policy or evidence itself.
- **Is purely descriptive and non-executable.** No persistence, no service,
  no API, no repository, no UI, no policy engine, no provider SDK type, no
  credential, no runtime client, no grant.
- **Validates only internal consistency**: required fields, paired-field
  combinations, and the resource-identity consistency check above.
  Resource-envelope shape validation is delegated entirely to
  `validateEnterpriseResourceEnvelope` -- never re-implemented. Never
  provider validation, credential validation, network/reachability checks,
  existence checks, authorization, or policy-correctness evaluation.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted scope/evidence-ref sets, undefined fields omitted rather
  than written as `null`), delegating the nested resource envelope to
  `serializeEnterpriseResourceEnvelope` / `deserializeEnterpriseResourceEnvelope`.
- **Provides identity equality derived from exactly three things**: resource
  identity, principal, and evaluation instant (Phase 7's required identity
  basis) -- never a fourth field, never a separately invented identity.

## Why `EnterpriseAccessDecision` composes both `EnterpriseScopedAccessRequest`
## and `EnterpriseResourceEnvelope`

`EnterpriseScopedAccessRequest` already carries `resource: ResourceRef` (via
Protocol's `ScopedAccessRequest`) -- the resource *as asked for*.
`EnterpriseResourceEnvelope` separately carries `resource: ResourceRef` --
the resource *as governed*, with location, integrity, and lifecycle. A
decision genuinely needs both views: what the requester named, and the full
governance record that request resolved to. Rather than pick one and lose
the other, this contract composes both and validates that they agree on
identity. This is the same "impossible combination" validation style
`EnterpriseResourceEnvelope` already uses for `location.systemReference`
requiring `location.system` -- a paired-field consistency check, not a
second source of truth.

## Why `PolicyDecision`, not `EnterprisePolicyDecision`

Both exist in the repository and are superficially similar. `PolicyDecision`
(`@aoc/protocol`) is a bare three-state outcome vocabulary; it is already
canonical across Soberanía (referenced by `PolicyDecisionResult.decision` in
Protocol's own adapter surface) and is a `protectedSymbol` in
`scripts/check-protocol-consumption.mjs`, meaning no Enterprise file may
redefine it -- only reuse it. `EnterprisePolicyDecision`
(`@aoc-enterprise/policy-runtime`) is one specific orchestration engine's
response shape and additionally carries `obligations`: a list of *runtime
instructions* (e.g. redact a field, notify a party). Reusing it here would
pull execution-shaped state into a contract whose entire purpose is to
record a completed, non-executable fact. See the package README's "Decision
semantics" section for the full comparison table.

No new decision vocabulary was invented; `PolicyDecision`'s three states
(`allow`, `deny`, `conditional`) are the minimum required model for "what
was decided."

## New contract responsibilities

- Represent the evaluated request (`request`), the governed resource
  (`resource`), and the requesting principal (`request.principalId`).
- Represent the decision outcome (`outcome`), when it was evaluated
  (`evaluatedAt`), and a correlation identifier (`correlationId`) linking it
  to the rest of an audit trail.
- Carry optional human-readable reason metadata (`reason`) and opaque
  references to the policy evaluation (`policyEvaluationRef`) and evidence
  (`evidenceRefs`) that informed the decision.
- Validate its own internal consistency (including cross-referencing
  `request.resource` against `resource.resource`) and (de)serialize
  deterministically.

## Explicit non-responsibilities

Enforced at compile time (see
`__tests__/enterprise-access-decision.test.ts`):

- API keys, provider credentials, bearer tokens, access keys, JWTs,
  authorization headers
- URLs, download links, temporary/signed grants
- Pinata-shaped, S3-shaped, or any other provider-specific object
- runtime clients, provider SDK instances or types
- grant identifiers, approval workflow state, revocation state -- these
  belong to a future `AccessGrant`, which will reference a decision, not
  extend it
- a policy engine, rule set, or permission-evaluation logic
- provider/network/existence validation and policy-correctness evaluation
  (excluded from `validateEnterpriseAccessDecision` by design, not by
  omission)

## Future integration path

```text
┌──────────────────────┐   ┌───────────────────────┐
│ @aoc/protocol          │   │ @aoc/protocol           │
│ ScopedAccessRequest      │   │ PolicyDecision            │
└──────────┬────────────┘   └───────────┬─────────────┘
           │ extended by                 │ reused directly
           ▼                             │
┌──────────────────────┐                 │
│ scoped-access           │                 │
│ EnterpriseScopedAccess-  │                 │
│ Request                    │                 │
└──────────┬────────────┘                 │
           │ composed by reference          │
           ▼                                 ▼
┌───────────────────────────────────────────────────┐
│ access-decision                                       │
│ EnterpriseAccessDecision                               │
│   request | resource | outcome | evaluatedAt |         │
│   correlationId | reason? | policyEvaluationRef? |     │
│   evidenceRefs?                                         │
└──────────┬──────────────────────────┬──────────────┘
           ▲                          │ future
┌──────────┴────────────┐             ▼
│ resource-envelope        │   AccessGrant / Audit / UsageEvent
│ EnterpriseResourceEnvelope│   (not implemented here)
└──────────────────────┘
```

**No adapter, grant, audit, or usage-event contract is implemented as part
of this change.**

## Tests

`packages/access-decision/__tests__/enterprise-access-decision.test.ts`:

- Positive: construction (full and minimal), composition (no duplicated
  principal/resource identity fields; both read only through
  `decision.request`/`decision.resource`), identity and structural equality,
  validation (accepting valid shapes, including the impossible-combination
  and delegated-envelope-validation checks), serialization determinism, and
  round-trip (de)serialization.
- Negative: compile-time `@ts-expect-error` proofs (matching the convention
  established in `packages/resource-envelope`) that the contract cannot
  carry API keys, bearer tokens, JWTs, credentials, access keys,
  authorization headers, URLs/download links, Pinata/S3-shaped objects,
  runtime clients, provider SDK instances, grant identifiers, approval
  workflow state, revocation state, a policy engine, or a duplicated
  `principalId`; plus that fields are immutable (`readonly`, no
  reassignment).

## Compatibility

- No change to `@aoc/protocol`, `ResourceRef`, `PolicyDecision`,
  `EnterpriseResourceEnvelope`, or `EnterpriseScopedAccessRequest`.
- New workspace package (`packages/access-decision`), added to the root
  `tsconfig.json` project references so `npm run build`/`typecheck` cover
  it, the same way `packages/resource-envelope` and `packages/scoped-access`
  are.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), so it does not
  need to be added to `scripts/validate-publishability.mjs`'s bundled
  workspace packages list, matching the precedent set by
  `packages/resource-envelope`.

## Blast radius

Existing and future code that *could* eventually adopt
`EnterpriseAccessDecision` once a policy engine and grant contract exist --
listed for future sequences, **not migrated by this change**:

- `packages/policy-runtime` -- `EnterprisePolicyEvaluationResponse.decisionId`
  is the natural value for a future `AccessDecision.policyEvaluationRef`;
  today the two are not wired together.
- A future `AccessGrant` contract -- will reference an
  `EnterpriseAccessDecision` as the evaluation that authorized issuing it.
- A future `Audit` contract -- will correlate audit entries to a decision's
  `correlationId`.
- A future `UsageEvent` contract -- will correlate recorded access back to
  the `EnterpriseAccessDecision` that authorized it.
- Any future provider adapter (not yet created) -- consumes a downstream
  `AccessGrant`, never this contract directly.
- `src/features/evidence-source-runtime/*` -- a future evidence bundle
  contract's identifiers are the natural value for
  `AccessDecision.evidenceRefs`; today no such bundle exists.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/access-decision` via
  the new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/access-decision`
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.E)

- No policy engine, evaluation logic, or permission check is implemented.
- No `AccessGrant`, `Audit`, or `UsageEvent` contract is implemented.
- No provider adapter is implemented.
- No persistence, API, service, repository, or UI is added.
- No existing consumer is migrated to this contract.
