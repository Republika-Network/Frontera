# ADR: In-custody issuance of execution capabilities (G-02B)

**Status:** Accepted (G-02B: custody rule, signer extension, Host issuer, issuance ledger, opt-in composition)
**Extends:** `ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md` (G-02A), `ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md` (CORE-02); follows TRADE-04C-S1's issuance pattern
**Security statement:** `docs/security/G-02B-EXECUTION-CAPABILITY-ISSUANCE.md` · invariants SEC-INV-367 … SEC-INV-374
**Founder decisions:** D1 – D8 (G-02B approval)

## Context

G-02A defined `frontera.execution-capability.v1`, its standalone verifier and a
reference consumption ledger, and deliberately shipped no way to sign one.
G-02B adds the one way: the existing CORE-02 authority key, inside its existing
custody boundary, signs a capability only for a bounded grant that the same key
signed, for exactly what that grant and the boundary's own policy allow, and
only after the Host has durably reserved the capability.

Nothing presents, transmits or delivers a capability yet. Where in the
execution path issuance happens is G-02C.

## Decision

### 1. One structured custody operation

`AuthorityArtifactSigner.signExecutionCapability?(request)` — optional, like
S1's `signDelegatedOfferCapability`. The request is the capability, the grant
as filed with its store id and authority signature, and the grant-reference
nonce. Before signing, every custody implementation runs
`assessExecutionCapabilityIssuance` (`authority-authenticity/execution-capability-issuance.ts`)
against **its own** key and **its own** policy, and signs
`executionCapabilitySigningBytes` (G-02A's function, unchanged) of the frozen
canonical record the rule accepted — never text as presented. There is no
`sign(bytes)`; external custody adds one structured path,
`/v1/sign/execution-capability`, offered only when required, and requests for
it are sent once (no availability retry).

The rule refuses unless:

| Check | Source of truth |
|---|---|
| canonical, closed, well formed | G-02A codec (re-read into a frozen copy) |
| `issuerKeyId` = active key; `issuer`, `organizationId`, `trustDomain` = policy | custody's own key and policy |
| `single-use`, `offline-permitted`, `onBehalfOfActorId: null` (D8) | rule |
| audience registered; action and binding format permitted for it | custody's own policy |
| grant digest and semantics well formed; grant signature verifies under the custody key | grant + custody key |
| `grantReference` = v2 reference of (nonce, store id, grant id, grant digest) | recomputed in custody |
| grant `scope.organization` = policy organization | grant |
| `subjectActorId` = grant subject; action = grant correlation (and scope) action; resource = grant correlation resource (and in scope) | grant |
| `executionId` = the governed path's derivation from the grant's request and decision | grant |
| grant unexpired by the custody clock; lifetime ≤ policy (≤ 60 s); not past the grant, not before it; issuance within 5 s of the clock | custody clock |

**Not decided in custody: current non-revocation (D4).** The boundary sees the
grant, not the revocation state. The Host-side issuer refuses a revoked grant
through the authenticated durable grant read (signed revocation state, CORE-07
freshness where composed) immediately before it reserves — as in S1. A
revocation committed after that read is bounded only by the capability window.

### 2. The custody policy and Host configuration (D3)

`createExecutionCapabilityIssuancePolicy` validates and freezes
`{ issuer, organizationId, trustDomain, lifetimeMs, audiences: [{ audience, actions, bindingFormats }] }`:
closed records, exact identifiers, no `*` or pattern, no duplicate, no default
issuer or audience, lifetime 1 … 60 000 ms. The Host's governed-action file
gains an opt-in `executionCapabilities` section (`issuer`, `lifetimeMs` default
30 000, `issuanceLedgerPath`, `audiences`); every action must be a routed one,
and organization and trust domain are the Host's own. The software signer is
built with the same policy; an external custody service is configured with its
own copy (`FRONTERA_REFERENCE_SIGNER_EXECUTION_CAPABILITY_POLICY_FILE` for the
reference launcher) and enforces it independently.

### 3. The Host issuer and the issuance ledger (D1, D5)

`createExecutionCapabilityIssuer` (`execution-capability-issuance/issuer.ts`):

1. refuse if the ledger already holds the execution, in whatever state;
2. read the grant through the authenticated store; refuse absent or revoked;
3. assemble the capability from policy, verified grant, a fresh 32-byte
   capability id and a fresh 32-byte nonce; apply the rule locally;
4. **reserve** in the ledger — full canonical text, grant identity, nonce;
5. ask custody **once**;
6. verify the returned signature locally under the active key; commit `issued`.

Failures are classified for the caller: everything before step 4 commits is
`never-requested` and leaves no row; everything after is `possibly-requested`
and leaves the row `uncertain` (or `reserved`, if the process stops). Neither
is ever issued again.

The ledger (`execution-capability-issuance/issuance-ledger.ts`,
`frontera.execution-capability-issuance-ledger.v1`) is its own SQLite file:
`execution_id` primary key, `capability_id` and nonce unique, pinned issuer,
states `reserved → issued | uncertain`, triggers for reserved-first insertion,
forward-only immutable rows and no delete, `quick_check` and a check that those
triggers exist **by name** on open (a raw writer could replace one with a no-op
of the same name; per-row re-derivation still refuses a tampered row), per-row re-derivation on every read, `IMMEDIATE` reservations with
`synchronous = FULL`. A missing file is never created by the Host.

### 4. The capability-specific grant reference (D2)

`grantReference = sha256(aoc.canonical-json.v1({ domain: frontera.execution-capability.grant-reference.v2, nonce, grantStoreId, boundedGrantId, grantDigest }))`
with a fresh 32-byte nonce per capability, kept in the Host ledger and sent to
custody; it is not a field of the capability. The wire field is unchanged
(`sha256:` + 64 hex); G-02A's per-grant v1 function remains for compatibility.
What this does and does not hide is analysed in the security statement §4.

### 5. Composition (no caller)

`composition-root.ts` composes issuance only when
`authorityControlledExecution.executionCapabilities` is present: it requires
the authenticated durable grant store it opened, a signer offering the
operation, a policy naming the deployment's organization and trust domain,
and the existing ledger; it binds a write-once slot. The Host creates and keeps
the slot, refuses to serve if it was not bound, and hands it to no route,
response, adapter or boot option (CORE-06 §23 keeps the Host's option surface
unchanged).

## Consequences

- An executor can now receive Frontera-signed capabilities — once G-02C
  connects a caller. Custody binds the issuer, organization, trust domain,
  subject, action, resource, execution and window to an authenticated grant
  and its own policy. It does **not** check the action-binding digest's
  content (the request itself) or the grant's amount, counterparty, parameter,
  action-class, resource-class or profile bounds: containment at issuance is
  action, resource, organization and subject only. The G-02C caller must bind
  only a request that the governed exercise has already admitted within those
  bounds (G02B-R5).
- "≤ 60 s" is measured from the capability's own `issuedAt`, which custody
  lets sit up to 5 s ahead of its clock: from custody's view a capability can
  stay valid for at most about 65 s.
- The issuance ledger is **not anchored against rollback** (D7): a restored or
  duplicated ledger lets the Host obtain a second valid capability for an
  execution. The G-02A executor ledger refuses it within one consumption
  domain only. This blocks any claim of rollback-resistant global issuance
  uniqueness in production until an anti-rollback strategy is approved.
- Grants signed under a former key are not eligible for new capabilities (D6).

## Deferred

| Milestone | Scope |
|---|---|
| G-02C | The caller (where in the execution path issuance happens), presentation to adapters, delivery semantics, executor receipts, ledger initialization tooling |
| G-02D | Online status for `online-status-required` |
| Later (founder) | Anti-rollback anchoring of the issuance ledger; delegation (`onBehalfOfActorId`) |
