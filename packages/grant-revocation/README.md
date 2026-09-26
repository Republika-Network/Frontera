# @aoc-enterprise/grant-revocation

The canonical Enterprise-owned contract for **the immutable record that a
previously-issued Access Grant is no longer valid**: `EnterpriseGrantRevocation`.
It references a future `EnterpriseAccessGrant` by an opaque grant identifier
(`grantRef: CanonicalId`) -- it never embeds, duplicates, or extends it.

This package is a pure data contract: no persistence, no service, no API, no
provider adapter, no URL invalidation, no cache invalidation, no session
termination, no JWT invalidation, no OAuth revocation, no timer, no
scheduler, no runtime enforcement.

## Purpose

A `Grant` answers *"what authorization exists?"*. Grants do not last forever:
they expire, an administrator withdraws them, the policy that permitted them
changes, the principal they were issued to is disabled, the resource they
covered is removed, or they are revoked in response to a security incident.
Something needs to record, immutably, *that* a grant stopped being valid and
*why* -- without becoming the mechanism that makes it stop being valid
anywhere else (a provider's API, a cached URL, a session, a token blacklist).
`EnterpriseGrantRevocation` is that record. It answers *"when and why did
that authorization cease to be valid?"*

## What this contract is not

- It does not enforce revocation.
- It does not contact providers (Pinata, S3, Azure Blob, Google Drive,
  SharePoint, or any other).
- It does not invalidate URLs.
- It does not invalidate caches.
- It does not terminate sessions.
- It does not invalidate JWTs or perform OAuth revocation.
- It does not schedule, time, or execute anything.

It records the immutable business fact that a grant is no longer valid; it
never carries that fact out.

## Ownership

- **The grant this record revokes** is referenced, not owned, via
  `grantRef: CanonicalId` -- an opaque pointer to a future
  `EnterpriseAccessGrant`'s own identity. This package never duplicates any
  grant field (resource, scope, expiry, status, ...).
- **Everything on `EnterpriseGrantRevocation`** -- `id`, `revokedAt`,
  `reason`, `issuerRef`, `correlationId`, `evidenceRefs?`, `description?` --
  is owned by Frontera Systems (`@aoc-enterprise/grant-revocation`).

## Why composition by reference, not embedding -- and why no `EnterpriseAccessGrant` needs to exist yet

No `EnterpriseAccessGrant` contract exists in this repository. It is
referenced only as a *future* concept, in the READMEs of
`@aoc-enterprise/resource-envelope`, `@aoc-enterprise/access-decision`, and
`@aoc-enterprise/access-obligation` (each of which says a future `AccessGrant`
will read or compose with it). That is not a blocker for this contract, for
the same reason `EnterpriseAccessObligation` did not need to import
`EnterpriseAccessDecision`'s full shape to compose with it -- it referenced
it by an opaque `decisionRef: CanonicalId` instead:

```ts
interface EnterpriseGrantRevocation {
  readonly grantRef: CanonicalId; // points at a future EnterpriseAccessGrant's own identity
  // ... id, revokedAt, reason, issuerRef, correlationId, evidenceRefs?, description?
}
```

A reference only requires a stable identifier space to point into
(`CanonicalId`, already defined by `@aoc/protocol`); it does not require the
referenced contract's shape to be defined yet. When `EnterpriseAccessGrant`
is eventually implemented, `grantRef` is understood to point at that
contract's own identity field -- no change to `EnterpriseGrantRevocation` is
required. This mirrors the precedent `EnterpriseAccessDecision.policyEvaluationRef`
already set: a reference to a policy-evaluation record whose shape
`@aoc-enterprise/access-decision` has never defined either.

A revocation is not "a grant with a status flag flipped" -- a grant and its
revocation have different lifecycles (a grant is issued once; it can be
revoked exactly once, by design -- see `validateEnterpriseGrantRevocationSet`)
and different owners (a grant is issued by whatever issues grants; a
revocation can be recorded by an administrator, a policy engine, or an
automated expiry process, none of which need to be the grant's issuer).
Embedding a full grant inside every revocation would also duplicate that
grant's own resource/scope identity for no benefit.

## Evaluated and not reused

Two revocation- or grant-shaped types already exist in this repository. Both
were evaluated and rejected, for a distinct reason:

| | `AuthorityGrant` (`src/features/authority-graph/domain/authority-grant.ts`) | `RevocationLink` (`src/features/authority-graph/domain/revocation-link.ts`) | `EnterpriseGrantRevocation` (this package) |
| --- | --- | --- | --- |
| Scope | One feature's (`authority-graph`) domain model of direct organizational authority (e.g. "Datasys grants Victor Project Manager authority for project:HMP-14665") | Revocation lineage for `AuthorityGrant`/`DelegationGrant`/role assignments in that same feature | Provider-neutral, engine-agnostic; revokes any future `EnterpriseAccessGrant` for governed-resource access |
| Reason vocabulary | `status: 'active' \| 'expired' \| 'suspended' \| 'revoked'` -- a lifecycle state on the grant itself, not a separate revocation record, and not a *reason* vocabulary at all | `reason: string` -- free text, no closed vocabulary | `reason: EnterpriseGrantRevocationReason` -- an 8-value closed, provider-neutral vocabulary (see below) |
| Fit for an immutable, cross-grant record of *why access to a governed resource* stopped being valid | No -- models organizational authority/role delegation, not resource access grants, and is a single feature's private domain type (`src/features/*`), not a canonical `packages/*` Enterprise contract | No -- same feature-private scope; its free-text `reason` cannot be validated against a closed, provider-neutral vocabulary the way Phase 4 requires | Yes -- the purpose-built canonical contract for this exact concept |

Neither was reused: `AuthorityGrant` records organizational authority, not
resource-access grants, and folds "revoked" into the grant's own `status`
field rather than a separate immutable event record; `RevocationLink` is
feature-private and has no closed reason vocabulary. Reusing either would
reach into one feature's private domain model from a canonical Enterprise
package, the same reasoning `EnterpriseAccessObligation`'s own README already
applied when it rejected `PolicyObligation`
(`src/features/domain-policy-pack-runtime`).

## Revocation reason vocabulary

`reason: EnterpriseGrantRevocationReason` is a closed, provider-neutral
vocabulary of exactly seven categories:

| Value | Meaning |
| --- | --- |
| `expired` | The grant's own validity window elapsed. |
| `administrator-revoked` | An administrator withdrew the grant directly. |
| `policy-changed` | The policy that permitted the grant no longer does. |
| `principal-disabled` | The grantee is no longer an eligible principal. |
| `resource-removed` | The governed resource itself is gone. |
| `manual-revocation` | A deliberate, one-off revocation not otherwise categorized. |
| `security-incident` | The grant was revoked in response to a security event. |

Each is a *description* of why a grant is no longer valid, never an
instruction to act on it: `'security-incident'` records that a grant was
revoked because of a security event, it does not run an incident-response
playbook; `'expired'` records that a validity window elapsed, it does not
invalidate any cached credential. No provider-specific reason (e.g.
`pinata-unpin-failed`, `s3-object-deleted`) is introduced (non-negotiable
rule). A future reason category is a `schemaVersion` change, not an open
string -- this is deliberately a closed union, mirroring the closed
`EnterpriseAccessObligationType` and `EnterpriseResourceLifecycleState`
vocabularies already established in this Enterprise contract line.

## Explicit non-responsibilities

`EnterpriseGrantRevocation` never carries, and by design cannot carry
(enforced at compile time via `@ts-expect-error` -- see
`__tests__/enterprise-grant-revocation.test.ts`):

- provider URLs, download links
- JWTs, OAuth tokens
- API keys, provider credentials
- Pinata-shaped, S3-shaped, Azure-shaped, or any other provider SDK client
- network/HTTP clients
- runtime callbacks
- session identifiers, cache keys
- grant fields (resource, scope, expiry, status, ...) -- these belong to a
  future `EnterpriseAccessGrant`, never duplicated or embedded here

## Relationship diagram

```text
┌───────────────────────────────────────────────────────────────────┐
│ EnterpriseAccessDecision / EnterpriseAccessObligation (existing)     │
│   "can access occur, and under what conditions?"                      │
└──────────────────────────────┬──────────────────────────────────────┘
                                 │ future, not implemented here
                                 ▼
                      ┌───────────────────────┐
                      │ EnterpriseAccessGrant    │   (future -- not implemented
                      │ "what authorization        │    by this package)
                      │  exists?"                    │
                      └───────────┬───────────────┘
                                   │ referenced by grantRef
                                   │ (never embedded)
                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│ @aoc-enterprise/grant-revocation                                       │
│                                                                          │
│ EnterpriseGrantRevocation                                                │
│   id | grantRef | revokedAt | reason | issuerRef | correlationId |        │
│   evidenceRefs? | description?                                            │
│                                                                              │
│ "when and why did that authorization cease to be valid?"                    │
└───────┬────────────┬────────────────┬─────────────────┬─────────────────┘
        │ future       │ future          │ future            │ future
        ▼              ▼                 ▼                    ▼
   UsageEvent    EvidenceCorrelation   Audit / Compliance   ProviderAdapter
   (stop         (ties revocation      (revocation appears    / Monitoring
   attributing    to correlationId's    in an immutable        (interprets a
   usage to a     wider audit trail)    audit trail)           revoked grant
   revoked grant)                                              when it next
                                                                reaches the
                                                                resource)
```

## Sequence diagram: grant lifecycle to revocation

```text
Administrator         EnterpriseAccessGrant      EnterpriseGrantRevocation      Future consumers
(or policy engine /        (future)                  (this package)          (UsageEvent, Audit,
 automated process)                                                        ProviderAdapter, ...)
      │                        │                            │                       │
      │  grant issued          │                            │                       │
      │───────────────────────▶│                            │                       │
      │                        │  grant is active            │                       │
      │                        │  (accessed, used, ...)       │                       │
      │                        │                            │                       │
      │  revocation trigger    │                            │                       │
      │  (expiry / admin /     │                            │                       │
      │   policy change /      │                            │                       │
      │   principal disabled / │                            │                       │
      │   resource removed /   │                            │                       │
      │   manual / incident)   │                            │                       │
      │                        │                            │                       │
      │  record revocation     │                            │                       │
      │  (grantRef = grant.id) │                            │                       │
      │────────────────────────┼───────────────────────────▶│                       │
      │                        │                            │  EnterpriseGrantRevocation
      │                        │                            │  is now the immutable  │
      │                        │                            │  business record that  │
      │                        │                            │  the grant is invalid  │
      │                        │                            │                       │
      │                        │                            │  future consumers read │
      │                        │                            │  this record and act   │
      │                        │                            │  in their own domain   │
      │                        │                            │──────────────────────▶│
      │                        │                            │                       │  UsageEvent stops
      │                        │                            │                       │  attributing usage
      │                        │                            │                       │  to grantRef
      │                        │                            │                       │
      │                        │                            │                       │  ProviderAdapter
      │                        │                            │                       │  (Pinata/S3/Azure/...)
      │                        │                            │                       │  invalidates its own
      │                        │                            │                       │  provider-side state
      │                        │                            │                       │  the next time it
      │                        │                            │                       │  reaches the resource
```

**No step after "record revocation" is implemented by this package.**
Everything below the `EnterpriseGrantRevocation` record in both diagrams is a
future consumer's responsibility, not this contract's.

## Future integration path

No provider adapter, enforcement layer, or grant contract is implemented or
assumed by this package. Because `reason` is a closed, provider-neutral
vocabulary and every reference field is an opaque `CanonicalId`, a future
adapter can interpret a revocation without this contract changing:

- A **Pinata adapter** interpreting a revocation with `reason:
  'resource-removed'` would unpin the IPFS-pinned object the next time it
  reaches that resource -- using its own SDK, never referenced by this
  contract.
- An **S3 adapter** interpreting `reason: 'security-incident'` would revoke
  any outstanding presigned URLs for the object the grant covered.
- An **Azure Blob adapter** interpreting `reason: 'expired'` would let its
  own SAS token expiry (already set independently) stand, or actively
  rotate the container key, depending on that adapter's own policy.
- A **Google Drive adapter** interpreting `reason: 'principal-disabled'`
  would remove the grantee's share permission.
- A **SharePoint adapter** interpreting `reason: 'administrator-revoked'`
  would remove the corresponding permission entry.

None of this is implemented here. This contract only records that a grant is
no longer valid, when, and why -- a future adapter decides, in its own
provider-specific code, what "no longer valid" means for that provider.

## Equality semantics

- `enterpriseGrantRevocationIdentityEquals(a, b)` -- identity equality,
  derived from `id`, `grantRef`, and `revokedAt` together (Phase 7's required
  basis: "revocation identity, grant reference, timestamp"), the same
  compound-identity pattern `enterpriseAccessDecisionIdentityEquals` already
  establishes rather than a bare single field.
- `enterpriseGrantRevocationEquals(a, b)` -- full structural equality:
  identity plus `reason`, `issuerRef`, `correlationId`, `evidenceRefs`, and
  `description`. "Do not derive equality from runtime execution" (Phase 7) is
  satisfied structurally: this contract has no execution-shaped field to
  begin with.

## Validation

- `validateEnterpriseGrantRevocation(candidate)` -- internal-consistency
  validation of a single revocation record: required fields, reference-field
  shape ("reference integrity" -- well-formed non-empty identifiers, never
  whether the referenced grant/issuer/correlation trail actually exists),
  timestamp well-formedness ("timestamp consistency"), and reason-vocabulary
  membership ("reason consistency"). Never provider, resource-existence,
  network, policy-correctness, or runtime-enforcement validation.
- `validateEnterpriseGrantRevocationSet(revocations)` -- duplicate detection
  across a collection ("duplicate revocations"): no two records may share an
  `id`, and no two records may claim to revoke the same `grantRef` -- a grant
  is revoked at most once. Deliberately a separate function, since
  "duplicate" is a property of a collection, not of any single record.

## Blast radius

Existing and future code that *could* eventually consume
`EnterpriseGrantRevocation` once a grant contract, usage tracking, and
provider adapters exist -- listed for future sequences, **not migrated by
this change**:

- A future `EnterpriseAccessGrant` contract -- would expose the grant that
  `grantRef` points at, and would be the natural place a revocation is
  looked up by grant identity.
- A future `UsageEvent` contract -- would stop attributing observed usage to
  a grant once a matching `EnterpriseGrantRevocation` exists for it.
- A future evidence-correlation contract -- would tie `correlationId` and
  `evidenceRefs` into a wider audit trail alongside `EnterpriseAccessDecision`
  and `EnterpriseAccessObligation` records.
- A future audit/compliance surface -- would render revocation records
  (reason, issuer, timestamp) as part of an immutable audit trail.
- Any future provider adapter (Pinata, S3, Azure Blob, Google Drive,
  SharePoint; none exist today) -- would interpret a revocation's `reason`
  when it next reaches the resource the revoked grant covered.
- A future monitoring surface -- would alert on `reason: 'security-incident'`
  revocations, or track revocation volume by `reason`.

## Install / build

Part of the Frontera Systems workspace:

```bash
npm run build --workspace @aoc-enterprise/grant-revocation
npm test --workspace @aoc-enterprise/grant-revocation
```
