# ADR: Canonical Policy Obligation (R004.F)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Related: R004.D (`ADR-RESOURCE-ENVELOPE.md`, `EnterpriseResourceEnvelope`),
  R004.E (`ADR-ACCESS-DECISION.md`, `EnterpriseAccessDecision`),
  `packages/canonical-runtime-contracts/src/governance/obligations.ts`
  (`CanonicalObligation`, evaluated and not reused),
  `packages/policy-runtime/src/contracts.ts` (`EnterprisePolicyObligation`,
  evaluated and not reused),
  `src/features/domain-policy-pack-runtime/domain/policy-pack-obligation.ts`
  (`PolicyObligation`, evaluated and not reused)

## Context

R004.E established `EnterpriseAccessDecision` as the canonical Enterprise
record of *the evaluated result* of a request against a resource: an outcome
(`allow`/`deny`/`conditional`), and nothing about what conditions attach to
that outcome. Real access decisions are frequently conditional: a resource
may be allowed for access only if multi-factor authentication is completed,
the content is watermarked before rendering, access is read-only, download is
disabled, a time limit applies, or a human approves first. Access Governance
needs a canonical, immutable way to record such a condition -- without
folding it into the decision's own outcome vocabulary (which
`EnterpriseAccessDecision`'s own README already explains was deliberately
kept to a bare three-state enum, specifically to keep execution-shaped state
out of that record) and without executing, enforcing, or interpreting the
condition itself.

Three obligation-shaped types already exist in the repository:

- `CanonicalObligation` / `ObligationType`
  (`@aoc-enterprise/canonical-runtime-contracts`, `governance/obligations.ts`)
  -- an 8-value enum used only by `PolicyEvaluationDecisionEnvelope` (a
  kernel-level runtime envelope), tuned to agent-governance actions
  (`dual_approval`, `sovereign_routing`, `rate_limited`, ...). Not referenced
  anywhere in the `EnterpriseResourceEnvelope`/`EnterpriseAccessDecision`
  composition line, and its `params?: Record<string, unknown>` is
  unconstrained.
- `EnterprisePolicyObligation` (`@aoc-enterprise/policy-runtime`,
  `contracts.ts`) -- `{ type: string; params?: Record<string, unknown> }`,
  the `obligations` field of one specific policy-evaluation orchestration
  engine's response (`EnterprisePolicyEvaluationResponse`). Already evaluated
  and rejected once, in `EnterpriseAccessDecision`'s own README ("Decision
  semantics"): described there as carrying *"a list of runtime instructions
  to carry out (e.g. redact a field, notify a party)"* -- execution-shaped,
  the opposite of what an immutable record may carry.
- `PolicyObligation` (`src/features/domain-policy-pack-runtime/domain/policy-pack-obligation.ts`)
  -- `{ id, type, description, required, metadata? }`, collected by
  `PolicyObligationService` from matched policy-pack rule results. Owned by,
  and exported only from, one feature's domain module
  (`src/features/domain-policy-pack-runtime`), not a canonical `packages/*`
  Enterprise contract, and has no correlation to an `EnterpriseAccessDecision`
  at all.

R004.C, R004.D, and R004.E's conclusions, treated as authoritative for this
sequence:

- Reuse a canonical concept when one exists; do not invent a duplicate enum
  without justification (R004.F Phase 4).
- Enterprise composes Protocol/Enterprise contracts *by reference* when the
  new type describes something *about* the composed value, never by
  embedding or extending it wholesale (established by
  `EnterpriseResourceEnvelope` wrapping `ResourceRef`, and
  `EnterpriseAccessDecision` wrapping `EnterpriseScopedAccessRequest` /
  `EnterpriseResourceEnvelope`).
- A superficially similar, differently-shaped existing type is not
  automatically the canonical one -- `EnterpriseAccessDecision` chose
  Protocol's bare `PolicyDecision` over the execution-shaped
  `EnterprisePolicyDecision` for exactly this reason, and documented why in
  its own README.

## Decision

Create `EnterpriseAccessObligation` in a new package,
`@aoc-enterprise/access-obligation` (`packages/access-obligation`):

- **References `EnterpriseAccessDecision` by an opaque correlation id**
  (`decisionRef: CanonicalId`, pointing at
  `EnterpriseAccessDecision.correlationId`), never by embedding it. Mirrors
  the reference style `EnterpriseAccessDecision.policyEvaluationRef` /
  `evidenceRefs` already establish for records owned elsewhere.
- **Does not reuse `CanonicalObligation`, `EnterprisePolicyObligation`, or
  `PolicyObligation`.** Each was evaluated and rejected for a distinct,
  documented reason (see the package README's "Why `CanonicalObligation`,
  `EnterprisePolicyObligation`, and `PolicyObligation` were not reused"
  section for the full comparison table): the first two carry an
  unconstrained `params: Record<string, unknown>` and (for
  `EnterprisePolicyObligation`) are explicitly execution-shaped by the
  precedent this same sequence already set; the third is a single feature's
  private domain type, not a canonical Enterprise package, and has no notion
  of a decision to correlate against.
- **Defines a new, closed `EnterpriseAccessObligationType` vocabulary** of
  exactly the eight categories this sequence's own evidence identifies
  (R004.F Phase 5): `require-approval`, `require-mfa`, `record-usage`,
  `watermark-content`, `read-only`, `time-limit`, `no-download`,
  `require-acceptance`. No provider-specific obligation type is introduced
  (non-negotiable rule). Every category remains declarative: this contract
  records that a category of condition applies, never how to carry it out.
- **Restricts `parameters` to JSON primitives and non-credential-shaped
  keys.** `parameters?: Readonly<Record<string, string | number | boolean>>`
  is the one field not drawn from a closed vocabulary (an obligation like
  `time-limit` genuinely needs a duration Enterprise cannot enumerate in
  advance). Two guards, documented in the package README, keep this open
  field from becoming a way to smuggle a credential, URL, or runtime object
  past this contract's otherwise fully closed, compile-time-checked shape:
  a JSON-primitive-only value check, and a forbidden-substring check on
  parameter names (`apiKey`, `token`, `jwt`, `credential`, `password`,
  `secret`, `bearer`, `url`, `accessKey`, `sessionId`, `cookie`).
- **Represents mandatory/optional semantics with a single `mandatory:
  boolean` field**, never a tri-state or workflow-shaped status; this
  contract never decides what happens when a mandatory obligation goes
  unsatisfied.
- **Is purely descriptive and non-executable.** No persistence, no service,
  no API, no policy engine, no execution, no MFA, no watermarking, no
  download restriction, no provider, no adapter, no runtime enforcement, no
  grant.
- **Validates per-obligation shape and, separately, duplicate identity
  across a collection.** `validateEnterpriseAccessObligation` checks
  required fields, vocabulary membership, and parameter consistency for one
  obligation; `validateEnterpriseAccessObligationSet` checks that no two
  obligations in a collection share an `id` -- a distinct function, because
  "duplicate" is a property of a collection, not of any single candidate.
- **Provides deterministic, round-trip-safe serialization** (fixed key
  order, sorted parameter/evidence-ref sets, undefined fields omitted rather
  than written as `null`).
- **Provides identity equality derived from `id` alone**, and full
  structural equality extending it to every other declarative field
  (`type`, `mandatory`, `decisionRef`, `severity`, `parameters`,
  `description`, `evidenceRefs`) -- satisfying Phase 8's required basis
  ("obligation identity, type, parameters") and, because this contract has
  no execution-shaped field at all, structurally satisfying "do not derive
  equality from runtime execution" rather than by omission.

## Why `EnterpriseAccessObligation`, not `PolicyObligation`

The task instructions for this sequence refer to the new contract generically
as "PolicyObligation" throughout. That name was not used for the exported
type, for the same reason `EnterpriseAccessDecision` (R004.E) was not named
`EnterprisePolicyDecision`: a same- or similar-named, differently-shaped type
already exists (in fact, two: `EnterprisePolicyObligation` in
`@aoc-enterprise/policy-runtime`, and `PolicyObligation` in
`src/features/domain-policy-pack-runtime`), and both are execution- or
feature-scoped in ways this canonical contract deliberately is not (see
"Context" above). Naming the new contract `EnterpriseAccessObligation` keeps
the "Envelope / Decision / Obligation" naming line internally consistent
(`resource-envelope`, `access-decision`, `access-obligation`) and makes clear
at every call site and import path that this is not a renamed
`EnterprisePolicyObligation` or a replacement for `PolicyObligation` -- it is
a new, purpose-built contract that composes with `EnterpriseAccessDecision`.

## New contract responsibilities

- Represent obligation identity (`id`), obligation type (`type`), and
  mandatory/optional semantics (`mandatory`).
- Represent obligation-specific parameters (`parameters?`), restricted to
  JSON primitives and non-credential-shaped keys.
- Represent an optional coarse severity bucket (`severity?`), reusing the
  `'info' | 'warning' | 'error' | 'critical'` vocabulary already established
  by `src/kernel/contracts/kernel-result.ts` and
  `src/features/domain-policy-pack-runtime/domain/policy-pack-rule.ts`.
- Reference the `EnterpriseAccessDecision` this obligation accompanies
  (`decisionRef`) and any evidence that informed it (`evidenceRefs?`).
- Carry optional human-readable documentation metadata (`description?`).
- Validate its own internal consistency (required fields, vocabulary
  membership, parameter shape) and, across a collection, duplicate identity;
  (de)serialize deterministically.

## Explicit non-responsibilities

Enforced at compile time (`@ts-expect-error`) and, for the one open
`parameters` field, at runtime (`FORBIDDEN_PARAMETER_KEY`) -- see
`__tests__/enterprise-access-obligation.test.ts`:

- decision outcome, grant identifiers, approval workflow state -- these
  belong to `EnterpriseAccessDecision` and a future `AccessGrant`
- URLs, download links
- API keys, provider credentials, bearer tokens, JWTs
- Pinata-shaped, S3-shaped, or any other provider-specific object
- runtime clients, provider SDK instances, runtime callbacks
- a policy engine, rule set, or permission-evaluation logic
- provider/network/user/role/permission validation (excluded from
  `validateEnterpriseAccessObligation` by design, not by omission)

## Future integration path

```text
┌───────────────────────────┐
│ access-decision              │
│ EnterpriseAccessDecision       │
└─────────────┬───────────────┘
               │ referenced by correlationId (never embedded)
               ▼
┌───────────────────────────────────────────┐
│ access-obligation                             │
│ EnterpriseAccessObligation                     │
│   id | type | mandatory | decisionRef |         │
│   severity? | parameters? | description? |       │
│   evidenceRefs?                                    │
└──────────┬──────────────────────┬────────────────┘
           │ future                │ future
           ▼                       ▼
   AccessGrant                Approval engine /
   (interprets mandatory       provider adapter
    obligations before          (Pinata / S3 / Azure --
    issuing a grant)             interprets watermark-content,
                                   read-only, no-download, time-limit)
```

**No adapter, grant, approval engine, or audit contract is implemented as
part of this change.**

## Tests

`packages/access-obligation/__tests__/enterprise-access-obligation.test.ts`:

- Positive: construction (full and minimal), composition (references
  `EnterpriseAccessDecision` by `decisionRef` only, never embeds any decision
  field), identity and structural equality, validation (accepting valid
  shapes, every canonical type/severity), duplicate-id detection across a
  collection, serialization determinism, and round-trip (de)serialization.
- Negative: rejecting missing/invalid required fields, an out-of-vocabulary
  `type`/`severity`, non-primitive parameter values, and
  credential/token/URL-shaped parameter keys; plus compile-time
  `@ts-expect-error` proofs (matching the convention established in
  `packages/resource-envelope` and `packages/access-decision`) that the
  contract cannot carry URLs, JWTs, provider SDK instances, credentials,
  download links, provider clients, runtime callbacks, approval state,
  grant identifiers, a policy engine, or a duplicated decision outcome; plus
  that fields are immutable (`readonly`, no reassignment).

## Compatibility

- No change to `@aoc/protocol`, `EnterpriseResourceEnvelope`,
  `EnterpriseAccessDecision`, `CanonicalObligation`,
  `EnterprisePolicyObligation`, or `PolicyObligation`.
- New workspace package (`packages/access-obligation`), added to the root
  `tsconfig.json` project references so `npm run build`/`typecheck` cover
  it, the same way `packages/access-decision` and
  `packages/resource-envelope` are.
- Not wired into `src/index.ts` or any public runtime export -- it has no
  runtime consumer yet by design (see "Blast radius" below), matching the
  precedent set by `packages/resource-envelope` and `packages/access-decision`.

## Blast radius

Existing and future code that *could* eventually adopt
`EnterpriseAccessObligation` once an approval engine, enforcement layer, and
grant contract exist -- listed for future sequences, **not migrated by this
change**:

- A future `AccessGrant` contract -- will read `mandatory` obligations
  attached to the `EnterpriseAccessDecision` it references before a grant is
  issued.
- A future `UsageEvent` contract -- will correlate observed access back to
  `record-usage`/`time-limit` obligations via `decisionRef`.
- A future evidence bundle contract -- the natural value for
  `EnterpriseAccessObligation.evidenceRefs`; today no such bundle exists.
- Any future provider adapter (Pinata, S3, Azure Blob, ...; none exist
  today) -- would interpret `watermark-content`, `read-only`, `no-download`,
  and `time-limit` obligations when actually reaching a resource.
- A future approval engine (none exists today) -- would interpret
  `require-approval`/`require-acceptance` obligations and gate grant
  issuance on their satisfaction.
- `packages/policy-runtime` -- `EnterprisePolicyEvaluationResponse.obligations`
  is a plausible future *source* of `EnterpriseAccessObligation` records
  (mapped, not reused); today the two are not wired together.
- `src/features/domain-policy-pack-runtime` -- `PolicyObligation` records
  collected by `PolicyObligationService` are a plausible future *source* of
  `EnterpriseAccessObligation` records for policy-pack-driven decisions;
  today the two are not wired together.

## Validation

Commands run against this change (see the PR description for exact output):

- `npm run build` (root `tsc -b`, includes `packages/access-obligation` via
  the new `tsconfig.json` reference)
- `npm run typecheck`
- `npm test --workspace @aoc-enterprise/access-obligation`
- `npm run lint`
- `npm run check:aoc-boundaries`
- `npm run check:protocol-consumption`
- `npm run validate:publishability`

## Non-goals (out of scope for R004.F)

- No policy engine, evaluation logic, or permission check is implemented.
- No MFA, watermarking, download-restriction, or any other enforcement is
  implemented.
- No `AccessGrant`, approval engine, or `UsageEvent` contract is
  implemented.
- No provider adapter is implemented.
- No persistence, API, service, repository, or UI is added.
- No existing consumer (`CanonicalObligation`, `EnterprisePolicyObligation`,
  `PolicyObligation`, or anything referencing them) is migrated to this
  contract.
