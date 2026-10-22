# ADR: Governed execution binding and safety gate (G-02C0)

**Status:** Accepted (G-02C0: request binding, pre-send hook, issuer integration, post-issuance verification, emergency re-check)
**Extends:** `ADR-EXECUTION-CAPABILITY-ISSUANCE.md` (G-02B), `ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md` (G-02A)
**Security statement:** `docs/security/G-02C0-GOVERNED-EXECUTION-BINDING.md` · invariants SEC-INV-375 … SEC-INV-380
**Founder decision:** Option D (pre-send hook in the Generic HTTP adapter core), approved at the G-02C0 Phase 0 gate

## Context

G-02B can sign a capability for an execution, but it takes the action-binding
digest from its in-process caller, and custody checks only the binding's
format (G02B-R5). Nothing tied a capability to the request that is actually
sent. Holding a grant does not make a request immutable. What does is the
frozen `ValidatedExecutionAction` (contained in the grant by the exercise gate)
combined with the pure mapper that turns it into one frozen
`GenericHttpWireRequest` before any I/O.

## Decision

### 1. Where: after the request is final, before DNS

```
GrantExecutionService   grant read → containment → P7 reservation → re-read → emergency → frozen action
  → registry            routing → adapter-scoped emergency check
  → Generic HTTP core   map (pure) → frozen request
      → pre-send gate   (only when composed for this adapter)
      → DNS → address policy → one send
```

The hook is an optional third parameter of `createGenericHttpExecutionAdapterCore`.
Its type is `(subject) => Promise<{ proceed: true } | { proceed: false }>`. The
subject is `{ adapterId, action, binding }`. It never includes the request
object, the credential or the runtime. Only an own data property `proceed`
equal to `true` proceeds. Without a gate the core is unchanged, and the
Kernel, orchestrator, exercise gate, registry, `ValidatedExecutionAction`,
P11, P12 and the routes do not change.

Rejected alternatives:

- **Issuing in the orchestrator** happens before the final exercise checks and
  before the request exists, and would put signing next to the governed path.
- **Issuing in `GrantExecutionService`** is a CORE change, adds an await after
  its last re-check, cannot see the request bytes, and breaks the rule that
  governed roots never reach signing.
- **A decorator that re-maps the request** would bind a recomputed copy, not
  the object that is sent.

### 2. What is bound: `frontera.http-request-binding.v1`

The record is built from the frozen request that is then sent:
`{ method, origin: { scheme: 'https', hostname, port }, target, headers, credentialHeader, body }`.

- `target` is the encoded path and query.
- `headers` holds **every** mapped header except the credential, sorted by
  name. This includes `content-type` and `content-length`.
- `credentialHeader` is the excluded header's **name**, or `null`.
- `body` is the exact string, or `null`.

Exactly one thing is excluded: the credential **value**. It is a secret and
operator configuration, never governed input. Headers that Node adds itself
(`host` and the connection and framing headers) are functions of the bound
origin, method and body. The digest is G-02A's
`executionCapabilityActionBindingDigest` over that record.

Other adapter kinds define their own format under the same rule: the adapter's
final immutable request, minus defined secrets, recomputable by the executor.

### 3. What the gate does

The gate is `src/enterprise/execution-capability-gate/`, built per listed
adapter by the composition root.

1. Compute the digest of the binding it was shown.
2. **Issue** through the Host's G-02B slot. That path checks the ledger, re-reads
   the grant through the authenticated store (which refuses a revoked grant),
   reserves durably, asks custody once, verifies the signature under the active
   key and commits.
3. **Verify** with the standalone G-02A verifier as the adapter's audience,
   pinned to this deployment's issuer and active key only. The verifier checks
   canonical form, signature, organization, trust domain, window, action,
   resource and binding, against the record the gate recomputed. The gate then
   also checks `executionId`, `subjectActorId` and `expiresAt ≤ action.notAfter`,
   which the verifier does not know.
4. **Re-read the adapter-scoped emergency stop** synchronously. Issuance
   awaited, so the registry's earlier read is stale.
5. Proceed.

Every refusal at any step is `{ proceed: false }`. The adapter then returns
`failed` / `ADAPTER_ERROR` with no DNS lookup and no socket. That is a definite
failure: nothing was sent. P11 records it, and the P7 reservation is released
as for any other `failed`. A capability that was issued but then withheld (for
example by a stop declared during custody) is never presented. Its row in the
issuance ledger stays `issued` as evidence.

### 4. Composition and configuration

- **Configuration.** The `executionCapabilities` section takes optional
  `adapters: [{ adapterId, audience }]`. Each `adapterId` must name a configured
  Generic HTTP adapter, at most once. Each `audience` must be registered with
  `frontera.http-request-binding.v1` and permit every action routed to that
  adapter. Any violation fails startup.
- **Composition.** The composition root builds the gates together with the
  adapters, before any store is opened. It binds each gate exactly once, after
  the issuer slot is bound. A gate gets the deployment's active key and its one
  emergency-control reader. An unbound gate refuses, and so does an unbound slot.
- **Surface.** No other module imports the gate. Neither the gated factory nor
  the hook type is exported from the module index or the Enterprise barrel.

### 5. Evidence: no schema change

Evidence joins by `executionId`: the P11 attempt and outcome on one side, and
the issuance ledger row on the other (canonical capability, including the
binding digest, plus signature). Neither schema changes.

## Consequences

- A gated adapter sends a request only when a capability exists whose signed
  binding is that exact request: for that action, resource, execution and
  subject, under this deployment's key, with no stop read after issuance. The
  request is a pure function of the action the exercise gate contained, so the
  capability cannot authorize anything broader than what governance admitted.
  That containment is the exercise gate's, and custody still does not check
  amount, counterparty or parameters (G02B-R5 remains for direct custody
  callers).
- Under external custody, a gated `execute()` makes one custody request
  (EP-056, single attempt) before its one provider request.
- Issuance costs latency before the send and adds an await, in the same class
  as the adapter's existing DNS await. A revocation that lands during the
  custody call is bounded by the capability window.
- Nothing is presented. Executor-side verification and consumption are only
  **simulated** in tests, over the request a fake network received.

## Deferred

| Milestone | Scope |
|---|---|
| G-02C1 | Presentation transport, executor receipts (own key and domain, P11 mapping, P12 ownership unchanged) |
| G-02D | Online status |
| Founder | Anti-rollback anchoring of the issuance ledger (D7); a shared consumption domain per audience; custody-side amount, counterparty and parameter containment |
