# Frontera Systems Runtime Flow

## Enterprise AI Agent Access Request Flow

1. **Agent identity assertion**
   - Agent presents workload identity credential (internal or federated IdP).
   - Identity adapter normalizes claims into Soberanía identity model.

2. **Request context construction**
   - Runtime builds context: principal, tenant, org boundary, requested action/resource, environment metadata, correlation ID.

3. **Capability submission & verification**
   - Agent presents capability token (or requests issuance path).
   - `capability-tokens` verifies authenticity, expiry, delegation chain integrity, and constraint syntax.

4. **Scope resolution & enforcement pre-check**
   - `scoped-access` resolves resource namespace and action mapping.
   - Scope matcher confirms token scope covers requested operation.

5. **Consent verification**
   - `consent-engine` evaluates whether applicable consent artifacts exist and remain valid.
   - Revocations, expirations, condition failures, and legal-basis mismatches short-circuit to deny.

6. **Policy evaluation**
   - `policy-runtime` assembles full decision context and executes enterprise policy set.
   - Policy sources can include internal rules and external policy engine adapters.
   - Decision result = allow | deny | allow-with-obligations.

7. **Decision enforcement**
   - Enforcement point applies decision.
   - For allow-with-obligations, runtime injects obligations (masking, redaction, transformation, just-in-time MFA, etc.).

8. **Audit trail generation**
   - `audit-sdk` emits immutable event envelope containing: who, what, when, why, policy revision, consent proof refs, capability ID/hash, outcome.
   - Events are published to configured sinks (SIEM, sovereign store, analytics bus).

9. **Response + lifecycle actions**
   - Agent receives decision and optional bounded delegation token for follow-on calls.
   - Optional post-decision hooks: risk scoring updates, anomaly detection signals, revocation triggers.

---

## Sequence (Conceptual)

`Agent -> Identity -> Capability Verify -> Scope Check -> Consent Engine -> Policy Runtime -> Enforcement -> Audit -> Resource`

All transitions are correlation-ID bound and replay-reconstructable from audit events.

---

## Failure Semantics

- **Fail-closed default** for identity, consent, capability, and policy outages.
- **Fail-open forbidden** except explicitly configured low-risk read paths with compensating controls.
- **Deterministic deny codes** to support explainability and operations.
- **Idempotent audit writes** using event IDs + causality IDs.

---

## Agent-to-Agent and Delegated Access

- Delegation allowed only via attenuated, time-bound sub-capabilities.
- Delegator must hold explicit delegation right in source capability.
- Delegation chains are validated at every hop; chain depth and breadth are policy-controlled.
- Revocation of parent capability invalidates descendants.

---

## Temporary Access Model

- JIT (just-in-time) access requests trigger elevated policy path.
- Temporary capabilities include absolute expiry and non-renewable nonce constraints by default.
- Elevated sessions require stronger audit granularity and optional human approval gates.

## Public runtime surface policy

Runtime consumers must import from stable SDK entrypoints only:

- `@aoc-enterprise/runtime`
- `@aoc-enterprise/runtime/authorization`
- `@aoc-enterprise/runtime/audit`
- `@aoc-enterprise/runtime/crypto`
- `@aoc-enterprise/runtime/adapters`

Internal runtime modules remain implementation details and are not a compatibility contract.

## External consumer boundary

The runtime is validated as a publishable package artifact, not only as a workspace module. CI and local validation run against packed tarballs to ensure external consumers can resolve declarations and runtime entrypoints through export maps alone.

This boundary is enforced with negative checks for deep import paths so internal runtime layering can evolve without creating accidental API commitments.

## Ownership Boundary
- Protocol defines semantic language and contract types.
- Enterprise executes authorization, enforcement, crypto verification, and auditing against canonical protocol types.
- Cross-repo validation flow: protocol validate+pack, enterprise install+validate, PMFreak install+validate.
