# Customer Principal and Subject Binding

- Status: implemented — identity foundation only; **no route consumes it yet**
- Source: `src/enterprise/customer-identity/`
- Composition: `createEnterprise({ customerIdentityAdmission: { enabled: true } })`
- Tests: `src/enterprise/__tests__/customer-identity-admission.test.ts`,
  `src/enterprise/__tests__/customer-identity-composition.test.ts`

## 1. The one fact this establishes

> This authenticated customer principal belongs to this organization and
> represents this Frontera actor.

Nothing more. Admission grants no authority, evaluates no policy, calls no
Kernel, issues no grant and executes nothing. It is the identity primitive the
future Governed Action Orchestrator consumes before it builds a Kernel request.

## 2. The trust transition

```
Authorization: Bearer <secret>
        │  extractBearerToken + matchApiKey (canonical, constant-time)
        ▼
Configured credential { key, organizationId, customerIdentity }
        │  eligibility: organizationId present, customerIdentity well-formed
        ▼
CustomerPrincipal { plane: 'customer', principalId, organizationId, externalSubject }
        │  organization = the credential's organizationId (never a request field)
        ▼
KernelAuthorityStore.findActorByExternalSubject(
    { system: false, organizationId }, organizationId, externalSubject)
        │  record checked: kind actor, same organization, same subject, active
        ▼
BoundCustomerIdentity { principal, actor: { actorId } }
        │
        ▼
(next) Governed Action Orchestrator → AocKernel.evaluate()
```

- **Authentication answers who is calling.**
- **Subject binding answers which Frontera actor they represent.**
- **Recognition answers whether that actor exists in the authority world.**
- **Authorization answers what that actor may do.**

**Authentication success is not authorization.** A `bound` result means only
that the credential represents the actor; recognition and authority are still
evaluated by the Kernel, against the current authority world, when an action is
requested. Admission caches no capability, delegation, grant eligibility or
policy outcome.

## 3. What makes a credential customer-plane eligible

`EnterpriseApiKey` gained an optional, non-secret `customerIdentity` block:

```ts
interface EnterpriseApiKey {
  readonly key: string;
  readonly organizationId?: string;
  readonly customerIdentity?: {
    readonly principalId: string;
    readonly externalSubject: { readonly system: string; readonly subjectId: string };
  };
}
```

A key is admitted only when it matched **and** it has an `organizationId`
**and** a well-formed `customerIdentity`. Identifiers must be non-empty, at most
256 characters, trim-stable (surrounding whitespace is refused, never trimmed)
and free of control characters.

- A valid legacy key (`key` or `key:org`) is **not** a valid customer principal.
- An unscoped key is refused (`CUSTOMER_AUTH_UNSCOPED`). It is never widened to
  `system`.
- `AOC_ENTERPRISE_API_KEYS` has no syntax for `customerIdentity` and is
  unchanged. The block is supplied through typed composition configuration
  (`EnterpriseConfiguration.authentication.apiKeys`). Deployment configuration
  syntax is deferred to the prompt that adds the Governed Action route.
- **The secret is not the identity.** `principalId` and `externalSubject` are
  configuration, so a key can be rotated by configuring a second key with the
  same `customerIdentity`. Both admit the same principal and actor. Reusing a
  `principalId` with a different organization or subject is refused at
  composition (`CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS`).

## 4. The binding source of truth

The only binding source is the Kernel Authority's
`(organizationId, system, subjectId)` external-subject index
(`KernelAuthorityStore.findActorByExternalSubject`, unique per organization,
durable in SQLite). There is no second binding table, map or file.

Admission is handed a one-method read port, `CustomerSubjectBindingReader`, and
never the store or `KernelAuthorityProvisioningService`. The production reader
(`createKernelAuthoritySubjectBindingReader`) reads with
`{ system: false, organizationId }`, the same least-privileged,
organization-scoped read an evaluation uses. So the store's own tenancy guard
refuses any read of another organization's bindings. Admission never
constructs `system: true`.

One Enterprise instance serves one authority organization
(`kernelAuthority.organizationId`). A customer credential scoped to any other
organization is refused at composition, and again at admission.

## 5. Admission outcomes

Admission failures happen **before the Kernel**. They are not `DENIED` or
`INDETERMINATE`, they write no Governance Record, and they carry no free-form
detail (the reason code is the whole answer).

| Case | Result | Reason | Future HTTP |
|---|---|---|---|
| No / empty `Authorization` header | `refused` | `CUSTOMER_AUTH_REQUIRED` | 401 |
| Header is not `Bearer <token>` | `refused` | `CUSTOMER_AUTH_MALFORMED` | 401 |
| Token matches no configured key | `refused` | `CUSTOMER_AUTH_INVALID` | 401 |
| Key has no `organizationId` | `refused` | `CUSTOMER_AUTH_UNSCOPED` | 403 |
| Key has no `customerIdentity` (legacy key) | `refused` | `CUSTOMER_IDENTITY_NOT_CONFIGURED` | 403 |
| `customerIdentity` malformed | `refused` | `CUSTOMER_IDENTITY_INVALID` | 403 |
| Key's organization not served here | `refused` | `CUSTOMER_ORGANIZATION_NOT_SERVED` | 403 |
| Subject bound to no actor (nothing is created) | `refused` | `CUSTOMER_SUBJECT_UNBOUND` | 403 |
| Bound actor revoked | `refused` | `CUSTOMER_SUBJECT_ACTOR_REVOKED` | 403 |
| Binding source threw / closed | `unavailable` | `CUSTOMER_SUBJECT_LOOKUP_FAILED` | 5xx |
| Binding source returned a record for a different kind, organization or subject | `unavailable` | `CUSTOMER_SUBJECT_BINDING_INCONSISTENT` | 5xx |
| Eligible key, active bound actor | `bound` | — | — |

The HTTP column is guidance for the route that will consume admission; no
mapping is implemented here.

## 6. Composition

`customerIdentityAdmission: { enabled: true }` fails composition with a
`CustomerIdentityConfigurationError` instead of starting in a weaker mode when:

| Code | Condition |
|---|---|
| `CUSTOMER_IDENTITY_AUTHORITY_UNAVAILABLE` | no Kernel Authority store is configured, injected, or openable |
| `CUSTOMER_IDENTITY_NO_CUSTOMER_CREDENTIAL` | no key carries `customerIdentity` |
| `CUSTOMER_IDENTITY_CREDENTIAL_UNSCOPED` | a key carries `customerIdentity` without `organizationId` |
| `CUSTOMER_IDENTITY_CREDENTIAL_INVALID` | a key's customer identity is malformed |
| `CUSTOMER_IDENTITY_ORGANIZATION_NOT_SERVED` | a customer key is scoped to another organization |
| `CUSTOMER_IDENTITY_PRINCIPAL_AMBIGUOUS` | one `principalId` names two identities |

Admission never reads `AOC_ENTERPRISE_REQUIRE_AUTH`. With the legacy switch
off, a caller without a credential is still refused.

Omitting the option changes nothing. The service is exposed as
`AocEnterprise.customerIdentityAdmission` for trusted in-process host code; the
package barrel exports its types only.

## 7. Invariants (Prompt 2 scope)

These are local to the customer-identity capability. They are not promoted to
system-wide `SEC-INV` entries, because no customer-facing route consumes them
yet.

| ID | Invariant | Evidence |
|---|---|---|
| IDENTITY-01 | A secure customer-plane credential resolves to exactly one configured non-secret principal identity. | authenticator tests; `PRINCIPAL_AMBIGUOUS` composition test |
| IDENTITY-02 | Every secure customer principal belongs to exactly one organization. | `CustomerPrincipal.organizationId` required; unscoped refusal |
| IDENTITY-03 | A secure customer principal cannot be created from an unscoped API key. | `CUSTOMER_AUTH_UNSCOPED` tests (with and without metadata) |
| IDENTITY-04 | A customer principal never carries `system:true`. | type has no `system`; runtime tests; structural `system: true` ban |
| IDENTITY-05 | An actor is derived only through the authority store's external-subject binding. | memory + SQLite bound tests; import allow-list |
| IDENTITY-06 | The caller cannot choose or override the resolved actor. | injected `actorId`/`organizationId`/`system`/`externalSubject` tests; header-injection tests |
| IDENTITY-07 | An unbound external subject fails closed and creates no actor. | `CUSTOMER_SUBJECT_UNBOUND` tests assert the store is unchanged |
| IDENTITY-08 | Cross-organization external-subject resolution fails closed. | memory + SQLite cross-tenant tests; non-system read-context test |
| IDENTITY-09 | Raw credential material never leaves the authenticator. | sentinel tests over principals, results, errors, service and public configuration |
| IDENTITY-10 | Identity admission grants no authority and performs no Kernel decision. | structural Kernel/grant/provisioning bans; no Governance Record written |
| IDENTITY-11 | Failure of the binding source results in no admitted identity. | throwing, closed and inconsistent binding-source tests |
| IDENTITY-12 | Existing v1 routes are unchanged by this capability. | evaluate parity test; HTTP adapter and `api-surface.v1.json` scan |

## 8. What this preserves

- **SEC-INV-001 / 003:** the Kernel is still the only decision producer.
  Admission never reaches it, and an unrecognized actor still cannot be
  allowed.
- **SEC-INV-024:** no AI in this layer (structural ban on provider/AI
  vocabulary).
- **SEC-INV-028:** credentials stay off `PublicEnterpriseConfiguration`, which
  still maps only `apiKeyCount` and `apiKeyOrganizationScopes`.
  `customerIdentity` is not exposed either.
- **SEC-INV-032:** authority writes still require an operator context.
  Admission has no path to one.
- **Constant-time lookup:** the canonical `matchApiKey` is the only credential
  comparison (structural test).

## 9. Not in scope

This change adds none of the following: a Governed Action route, grant
endpoints, an adapter registry, a kill switch, aggregate limits, an event
stream, OIDC/JWT/mTLS, delegating-application ("act as") binding, or an
operator API.

The contract is mechanism-neutral: a future OIDC, mTLS or workload-identity
authenticator produces the same `CustomerPrincipal`.
