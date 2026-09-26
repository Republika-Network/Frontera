# @aoc-enterprise/access-obligation

The canonical Enterprise-owned contract for **a mandatory or optional
condition attached to an evaluated access decision**:
`EnterpriseAccessObligation`. It references `EnterpriseAccessDecision`
(`@aoc-enterprise/access-decision`) by an opaque correlation id -- it never
embeds, duplicates, or extends it.

This package is a pure data contract: no persistence, no service, no API, no
policy engine, no execution, no MFA, no watermarking, no download
restriction, no provider, no adapter, no runtime enforcement, no grant.

## Purpose

`EnterpriseAccessDecision` answers *"can access occur?"* (`outcome: 'allow' |
'deny' | 'conditional'`). Many real decisions are not unconditional: a
decision can allow access **provided** multi-factor authentication is
completed, the content is watermarked, the access is read-only, or a human
approves first. Something needs to record those mandatory conditions
immutably, alongside the decision, without turning the decision itself into
an execution plan. `EnterpriseAccessObligation` is that record. It answers
*"under what mandatory conditions?"* -- the bridge between a `Decision` and a
future `Grant`.

## What this contract is not

- It does not evaluate policy.
- It does not execute obligations (it does not perform MFA, does not
  watermark content, does not enforce read-only or no-download, does not
  send notifications).
- It does not grant access.
- It does not communicate with providers.

It records the immutable existence of a condition; it does not carry that
condition out.

## Ownership

- **The evaluated decision this obligation accompanies** is referenced, not
  owned, via `decisionRef: CanonicalId` -- an opaque pointer to an
  `EnterpriseAccessDecision.correlationId` (`@aoc-enterprise/access-decision`).
  This package never duplicates any `EnterpriseAccessDecision` field
  (`request`, `resource`, `outcome`, `evaluatedAt`, ...); see the negative
  tests in `__tests__/enterprise-access-obligation.test.ts`.
- **Everything on `EnterpriseAccessObligation`** -- `id`, `type`,
  `mandatory`, `severity?`, `parameters?`, `description?`, `evidenceRefs?` --
  is owned by Frontera Systems (`@aoc-enterprise/access-obligation`).

## Why composition by reference, not embedding

Following the precedent `EnterpriseAccessDecision` itself set for
`policyEvaluationRef`/`evidenceRefs` (opaque pointers to records owned
elsewhere, never embedded shapes):

```ts
interface EnterpriseAccessObligation {
  readonly decisionRef: CanonicalId; // points at EnterpriseAccessDecision.correlationId
  // ... id, type, mandatory, severity?, parameters?, description?, evidenceRefs?
}
```

An obligation is not "a decision with conditions bolted on" -- a decision and
its obligations have different cardinalities (one decision, zero or more
obligations) and different lifecycles (an obligation can be interpreted,
satisfied, or reinterpreted long after the decision that produced it was
recorded). Embedding a full `EnterpriseAccessDecision` inside every
obligation would also duplicate that decision's own resource/request
identity for no benefit. A reference keeps `EnterpriseAccessObligation` a
strictly smaller, independently serializable record, exactly the way
`EnterpriseAccessDecision.policyEvaluationRef` keeps that contract from
assuming the shape of whatever produced it.

## Why `CanonicalObligation`, `EnterprisePolicyObligation`, and `PolicyObligation` were not reused

Three obligation-shaped types already exist in this repository. Phase 4 of
this sequence requires reusing a canonical obligation concept if one exists,
and forbids inventing a duplicate enum without justification. Each existing
type was evaluated and rejected, for a distinct reason:

| | `CanonicalObligation` (`@aoc-enterprise/canonical-runtime-contracts`) | `EnterprisePolicyObligation` (`@aoc-enterprise/policy-runtime`) | `PolicyObligation` (`src/features/domain-policy-pack-runtime`) | `EnterpriseAccessObligation` (this package) |
| --- | --- | --- | --- | --- |
| Scope | One kernel-level envelope's (`PolicyEvaluationDecisionEnvelope`) obligation list; not referenced by any Access Governance contract | One specific policy-evaluation orchestration engine's response shape (`EnterprisePolicyEvaluationResponse.obligations`) | One specific feature's (policy-pack rule evaluation) domain object, collected by `PolicyObligationService` from matched rule results | Provider-neutral, engine-agnostic; attaches to any `EnterpriseAccessDecision` |
| Type vocabulary | 8-value closed enum tuned to *agent governance* actions (`dual_approval`, `sovereign_routing`, `rate_limited`, ...) -- no `watermark-content`, `no-download`, or `read-only` equivalent | Open `type: string` -- no closed vocabulary at all | 8-value closed enum tuned to *policy-pack rule* bookkeeping (`record_event`, `retain_evidence`, `run_dry_run_first`, ...) -- also no resource-access-restriction equivalent | 8-value closed enum matching this sequence's evidence (`require-approval`, `require-mfa`, `record-usage`, `watermark-content`, `read-only`, `time-limit`, `no-download`, `require-acceptance`) |
| Carries | `params?: Record<string, unknown>` -- unconstrained, can carry any shape including runtime objects | `params?: Record<string, unknown>` -- same; also has no `mandatory`/`required` field, and its own package README documents `obligations` as *"a list of runtime instructions to carry out"* | `id`, `description`, `required: boolean`, `metadata?: Record<string, unknown>` -- shape overlaps but is owned by, and only exported from, one feature's domain module, not a canonical Enterprise package | `id`, `type`, `mandatory`, `decisionRef`, `severity?`, `parameters?` (restricted to JSON primitives and non-credential-shaped keys), `description?`, `evidenceRefs?` |
| Fit for an immutable, cross-decision record | No -- scoped to one envelope, never referenced by `EnterpriseAccessDecision`/`EnterpriseResourceEnvelope`, and its `params: Record<string, unknown>` cannot be validated closed | No -- see `@aoc-enterprise/access-decision`'s own README ("Decision semantics"): this is explicitly the *execution-shaped* obligation shape that contract was designed to keep out | No -- it is a feature-internal domain type (`src/features/*`), not part of the `packages/*` canonical Enterprise contract line `EnterpriseResourceEnvelope`/`EnterpriseAccessDecision` belong to, and has no correlation to a decision at all | Yes -- the purpose-built canonical contract for this exact concept |

Reusing any of the three would either pull execution-shaped
`Record<string, unknown>` state into an immutable record (`CanonicalObligation`,
`EnterprisePolicyObligation`), or reach into a single feature's private
domain model from a canonical Enterprise package
(`PolicyObligation`/`src/features/domain-policy-pack-runtime`) -- the same
reasoning `EnterpriseAccessDecision`'s README already applied when it chose
`PolicyDecision` over `EnterprisePolicyDecision`. No fourth obligation type
was invented from nothing: `EnterpriseAccessObligation`'s eight categories
are exactly this sequence's own evidence (R004.F Phase 5), narrowed to the
minimum required model and never treated as executable (see
`ENTERPRISE_ACCESS_OBLIGATION_TYPES`'s doc comment).

## Why `EnterpriseAccessObligation`, not `EnterprisePolicyObligation` or `PolicyObligation`

Naming this contract "PolicyObligation" would collide, in spirit and almost
in name, with two existing and differently-shaped types (see the table
above). Naming it after what it actually composes with --
`EnterpriseAccessDecision` -- keeps the "Envelope / Decision / Obligation"
naming line internally consistent (`resource-envelope`, `access-decision`,
`access-obligation`) and avoids a reader assuming this contract is
`EnterprisePolicyObligation` renamed, or a replacement for
`PolicyObligation`. Neither is true: this package does not touch, does not
replace, and is not consumed by either.

## Obligation semantics

`type: EnterpriseAccessObligationType` is a closed, provider-neutral
vocabulary (`require-approval`, `require-mfa`, `record-usage`,
`watermark-content`, `read-only`, `time-limit`, `no-download`,
`require-acceptance`). Each category is a *description* of a condition, never
an instruction: `'require-mfa'` records that MFA is a condition of the
decision, it does not perform MFA; `'watermark-content'` records that
content must be watermarked before rendering, it does not watermark
anything. Interpreting and carrying out an obligation is the job of a future
approval engine, enforcement layer, or provider adapter -- never this
contract. See "Future integration path" below.

`mandatory: boolean` records whether an obligation must be satisfied
(`true`) or is merely advisory (`false`). This contract never decides what
happens if a mandatory obligation goes unsatisfied -- that decision belongs
to whatever future component enforces obligations, not to this immutable
record.

## Parameters are the one open extension point, and it is guarded

`parameters?: Readonly<Record<string, string | number | boolean>>` is
deliberately the only field on this contract not drawn from a closed
vocabulary -- an obligation category like `'time-limit'` needs to carry a
duration, and Enterprise cannot enumerate every parameter every future
category will need. Two guards keep this open field from becoming a
back door for the concepts Phase 10 requires this contract to never carry:

1. **Value type is restricted to JSON primitives** (`string | number |
   boolean`) -- `parameters` can never hold a nested object, an array, a
   function, or a class instance (e.g. a provider client). Enforced by
   `validateEnterpriseAccessObligation`'s `INVALID_PARAMETERS` check.
2. **Parameter *names* are checked against a forbidden-substring list**
   (`apiKey`, `token`, `jwt`, `credential`, `password`, `secret`, `bearer`,
   `url`, `accessKey`, `sessionId`, `cookie`, ...) -- a parameter named
   `apiKey` or `downloadUrl` is rejected even though TypeScript's
   excess-property checking (which polices every other field on this
   contract) cannot see inside an open `Record<string, ...>`. Enforced by
   `validateEnterpriseAccessObligation`'s `FORBIDDEN_PARAMETER_KEY` check.

## Explicit non-responsibilities

`EnterpriseAccessObligation` never carries, and by design cannot carry
(enforced at compile time via `@ts-expect-error` and at runtime via
`FORBIDDEN_PARAMETER_KEY` -- see `__tests__/enterprise-access-obligation.test.ts`):

- decision outcome, grant identifiers, or approval workflow state -- these
  belong to `EnterpriseAccessDecision` and a future `AccessGrant`, neither of
  which this contract embeds or extends
- URLs, download links
- API keys, provider credentials, bearer tokens, JWTs
- Pinata-shaped, S3-shaped, or any other provider-specific object
- runtime clients, provider SDK instances, or runtime callbacks
- persistence, a service, an API

## Relationship diagram

```text
┌─────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/access-decision                                    │
│                                                                       │
│ EnterpriseAccessDecision                                             │
│   request | resource | outcome | evaluatedAt | correlationId | ...   │
└──────────────────────────────┬────────────────────────────────────┘
                                 │ referenced by correlationId
                                 │ (never embedded)
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/access-obligation                                   │
│                                                                       │
│ EnterpriseAccessObligation                                           │
│   id | type | mandatory | decisionRef |                              │
│   severity? | parameters? | description? | evidenceRefs?             │
└───────────────┬───────────────────────────────────┬────────────────┘
                 │                                    │ future, not
                 │ future, not implemented here        │ implemented here
                 ▼                                    ▼
      ┌───────────────────────┐          ┌──────────────────────────┐
      │ AccessGrant (future)    │          │ Approval engine (future)  │
      │ - interprets mandatory   │          │ - decides how a           │
      │   obligations before      │          │   'require-approval'/      │
      │   issuing a grant          │          │   'require-acceptance'      │
      └───────────────────────┘          │   obligation is satisfied  │
                                           └──────────────────────────┘
      ┌───────────────────────┐          ┌──────────────────────────┐
      │ UsageEvent (future)     │          │ Provider adapter (future) │
      │ - records that a          │          │ - interprets              │
      │   'record-usage'/           │          │   'watermark-content'/      │
      │   'time-limit' obligation    │          │   'read-only'/'no-download'  │
      │   was observed at run-time    │          │   when actually reaching   │
      └───────────────────────┘          │   the resource, e.g. Pinata,│
                                           │   S3, or Azure adapters     │
                                           └──────────────────────────┘
```

## Future integration path

No provider adapter, approval engine, or grant contract is implemented or
assumed by this package. Because `type` is a closed, provider-neutral
vocabulary and `parameters` is restricted to JSON primitives, a future
adapter can interpret an obligation without this contract changing:

- A **Pinata adapter** interpreting `{ type: 'watermark-content', parameters:
  { text: 'CONFIDENTIAL' } }` would watermark the IPFS-pinned object before
  serving it -- using its own SDK, never referenced by this contract.
- An **S3 adapter** interpreting `{ type: 'no-download', mandatory: true }`
  would issue a view-only presigned URL instead of a download-capable one.
- An **Azure Blob adapter** interpreting `{ type: 'time-limit', parameters: {
  durationSeconds: 3600 } }` would set the presigned URL's expiry
  accordingly.
- A future **approval engine** interpreting `{ type: 'require-approval',
  mandatory: true }` would gate issuing an `AccessGrant` on a human decision.

None of this is implemented here. This contract only records that the
condition exists, is mandatory or optional, and (optionally) what parameters
describe it.

## Equality semantics

- `enterpriseAccessObligationIdentityEquals(a, b)` -- identity equality,
  derived from `id` alone (Phase 3's "obligation identity" field).
- `enterpriseAccessObligationEquals(a, b)` -- full structural equality:
  identity plus `type`, `mandatory`, `decisionRef`, `severity`, `parameters`,
  `description`, and `evidenceRefs`. This satisfies Phase 8's required basis
  ("obligation identity, type, parameters") and extends it to every
  remaining declarative field, the same way
  `enterpriseResourceEnvelopeEquals`/`enterpriseAccessDecisionEquals` extend
  their own identity functions. "Do not derive equality from runtime
  execution" (Phase 8) is satisfied structurally: this contract has no
  execution-shaped field to begin with.

## Validation

- `validateEnterpriseAccessObligation(candidate)` -- internal-consistency
  validation of a single obligation: required fields, type/severity
  vocabulary membership, parameter shape (JSON primitives only, no
  credential/URL-shaped keys), and evidenceRefs shape. Never provider,
  network, user, role, permission, or runtime-state validation.
- `validateEnterpriseAccessObligationSet(obligations)` -- duplicate detection
  across a collection: no two obligations attached to the same decision may
  share an `id`. Deliberately a separate function, since "duplicate" is a
  property of a collection, not of any single obligation.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/access-obligation
npm test --workspace @aoc-enterprise/access-obligation
```
