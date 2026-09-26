# Frontera Systems Foundation Architecture

## 1) Layered Separation of Concerns

Soberanía is intentionally split into three layers with strict one-way dependency flow:

1. **Soberanía Protocol (primitive layer)**
   - Defines portable, implementation-agnostic security and governance primitives.
   - Owns the normative models for consent, scoped access, capability semantics, identity claims, and audit events.
   - Must remain product-neutral and enterprise-neutral.

2. **Frontera Systems (orchestration layer)**
   - Operationalizes protocol primitives for enterprise-grade deployment and governance.
   - Provides runtime policy decisions, organizational boundary management, tenancy, control planes, connector frameworks, and operations tooling.
   - May compose protocol primitives, but cannot redefine primitive semantics.

3. **Applications (product layer)**
   - Domain products (e.g., PMFreak, HRKey) that consume enterprise services.
   - Own business workflows, UX, product-specific data models, and product policy templates.
   - Must not bypass protocol or enterprise enforcement paths.

### Core Rule

> Canonical protocol contracts are defined in AOC-Protocol and consumed by enterprise orchestration contracts. See `docs/architecture/protocol-integration.md`.

> **Upward composition only:** Protocol -> Enterprise -> Applications. No reverse dependencies.

---

## 2) Foundational Package Responsibilities

### `consent-engine`
- Canonical consent model, grant lifecycle, revocation, expiry, and conditional constraints.
- Consent proof representation and validation interfaces.
- Deterministic consent evaluation outputs for runtime use.

### `capability-tokens`
- Capability document schema (subject, resource, scope, constraints, expiry, delegation chain).
- Issuance/verification interfaces; detached from a specific cryptographic provider.
- Delegation, attenuation (scope narrowing), and token introspection support.

### `scoped-access`
- Resource namespace model and scope grammar.
- Scope matching and attenuation logic.
- Mapping between capability scopes and concrete resource actions.

### `policy-runtime`
- Enterprise runtime for policy evaluation and decisioning (allow/deny/conditional).
- Pluggable adapters for external policy engines (e.g., OPA, Cedar-like engines).
- Context assembly (identity, consent state, capability claims, environmental signals).

### `identity`
- Workload/agent/human/service identity abstraction.
- Claims normalization across internal and external IdPs.
- Trust context, assurance level metadata, and key material reference interfaces.

### `audit-sdk`
- Standardized immutable event envelopes for security/governance actions.
- Correlation IDs, causality chains, actor/resource/policy decision attribution.
- Multi-sink publishing abstraction (SIEM, data lake, event bus, sovereign stores).

---

## 3) Layer Placement by Logical Ownership

## Protocol-Level Primitives
- `consent-engine` (primitive semantics and core evaluation model)
- `capability-tokens` (semantic model and validation contracts)
- `scoped-access` (scope grammar and matching contracts)
- `identity` (primitive identity and claims contracts)
- `audit-sdk` (canonical event schema and emission contract)

## Enterprise Orchestration
- `policy-runtime` (runtime policy decisions and enterprise guardrails)
- Enterprise wrappers/adapters around protocol packages (tenant, org, environment controls)
- Connector frameworks (IdP, policy engines, storage, key management, external systems)

## Product-Specific
- Product access templates and domain-level policy packs
- Product data access maps and business workflow gating
- Product UX/API composition over enterprise control-plane/runtime APIs

---

## 4) Dependency Boundaries, Anti-Coupling, Extensibility, Integrations

## Dependency Boundaries
- Protocol packages may depend only on shared protocol utilities (serialization, time abstraction, validation helpers).
- Enterprise packages may depend on protocol packages, never the reverse.
- Product packages may depend on enterprise SDKs/APIs and selected protocol SDKs for client-side validation.

## Anti-Coupling Rules
- No package may import product domain objects into protocol or enterprise packages.
- No direct cross-package datastore access; all state interactions go through explicit interfaces.
- Token format, policy engine, and storage engine must be interface-driven to avoid hard vendor coupling.
- Policy evaluation context contract is versioned and backward compatible.

## Future Extensibility Rules
- All decision contracts use additive, versioned schemas.
- All critical runtime components support “strict mode” and “compatibility mode” during upgrades.
- Capability constraints and consent conditions must support unknown-field pass-through.
- Delegation chain and audit envelope designed for multi-hop causality.

## Plugin & Integration Philosophy
- **Ports-and-adapters by default**: internal domain contracts at center, adapters at edges.
- Certify connectors per trust tier (sandbox, verified, regulated).
- Integration lifecycle: register -> validate capabilities -> grant scoped execution -> observe/audit -> revoke.
- External plugins execute with least privilege and time-bounded capabilities.

---

## 5) Architectural Principles

1. **Zero trust everywhere**: every request authenticated, authorized, scoped, and auditable.
2. **Capability over role**: grants are explicit, attenuated, and time-bound.
3. **Consent as first-class control signal**: policy decisions are consent-aware by construction.
4. **Separation of control plane and data plane**: governance orchestration cannot be bypassed by runtime data operations.
5. **Sovereign by design**: deployment topology, keys, logs, and storage are customer-selectable.
6. **Composability over monolithics**: primitives + orchestrators + product composition.
7. **Deterministic governance decisions**: explainable allow/deny with reproducible inputs.
8. **Auditability as a protocol concern, not an afterthought**.

---

## 6) Bounded Contexts

- **Identity Context**: principal models, trust assertions, federation.
- **Consent Context**: grants, revocations, expiration policies, legal basis metadata.
- **Capability Context**: issuance, delegation, attenuation, verification.
- **Policy Context**: evaluation inputs, rule packs, decision outputs.
- **Access Context**: resource namespace, scope resolution, action mediation.
- **Audit Context**: event schema, correlation, retention/export.
- **Tenant/Org Context** (enterprise): tenant isolation, org graphs, boundary enforcement.
- **Integration Context** (enterprise): connectors, adapters, extension sandboxing.

---

## 7) Future Scaling Considerations

- Horizontally scalable policy decision points (PDP) with regional placement.
- Partitioned audit event pipelines with guaranteed ordering per correlation stream.
- Tenant-isolated key hierarchies and envelope encryption for cross-region compliance.
- Control-plane eventual consistency with deterministic policy snapshot IDs.
- Hot path optimization via short-lived decision caches bound to token hash + policy revision.
- Backpressure-aware audit ingestion with lossless durable queues.
- Multi-region failover with explicit consistency/latency profiles per tenant.
