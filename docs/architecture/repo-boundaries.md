# Frontera Systems Monorepo Boundaries & Strategy

## Recommended Monorepo Layout

- `packages/protocol/*`
  - `consent-engine`
  - `capability-tokens`
  - `scoped-access`
  - `identity`
  - `audit-sdk`
- `packages/enterprise/*`
  - `policy-runtime`
  - `tenant-governance`
  - `org-boundary`
  - `integration-runtime`
  - `control-plane-sdk`
- `packages/apps/*`
  - `pmfreak-*`
  - `hrkey-*`
- `packages/shared/*`
  - cross-cutting utilities with no domain semantics
- `docs/architecture/*`

---

## Dependency Diagram (Logical)

```text
apps/*
  -> enterprise/control-plane-sdk
  -> enterprise/policy-runtime
  -> protocol/* (client-safe contracts only)

enterprise/*
  -> protocol/consent-engine
  -> protocol/capability-tokens
  -> protocol/scoped-access
  -> protocol/identity
  -> protocol/audit-sdk
  -> shared/*

protocol/*
  -> shared/*
```

Forbidden:
- `protocol/* -> enterprise/*`
- `protocol/* -> apps/*`
- `enterprise/* -> apps/*`
- any package importing private internals from another package (public API only)

---

## Internal Dependency Enforcement

- Enforce package boundary linting in CI.
- Publish explicit `public` entrypoints; block deep-imports.
- Add architecture tests validating allowed import graph.
- Use semantic versioning and automated API compatibility checks.

---

## Multi-Tenancy & Isolation Model

- Tenant isolation modes:
  1. Logical isolation (shared control plane, isolated data namespaces)
  2. Strong isolation (dedicated data plane per tenant)
  3. Sovereign isolation (customer-managed infra and keys)
- Per-tenant policy bundles, key roots, and audit retention controls.
- Cross-tenant access denied by default; exceptions require explicit trust contracts.

---

## External System Extensibility

### External Identity Providers
- Support OIDC/SAML/SCIM adapters through `integration-runtime`.
- Map external claims into canonical identity contract; never leak raw provider semantics inward.

### External Policy Engines
- Adapter contract for request/response translation, decision metadata, and explanation artifacts.
- Require deterministic decision IDs and policy revision IDs.

### External Storage Providers
- Abstract storage via durability, encryption, and consistency capability descriptors.
- Capability enforcement layer remains storage-agnostic.

### Future Blockchain Interoperability (Optional)
- Treat blockchain as an optional attestation/export backend, not core dependency.
- Audit hash anchoring can be added as pluggable sink.
- Capability and consent runtime must remain fully functional without chain availability.

---

## Anti-Overengineering Guardrails

- Start with minimal primitive contracts and evolve additively.
- Prefer interface compatibility over speculative abstraction layers.
- Introduce new bounded contexts only when independent lifecycle and ownership are proven.
- Keep crypto/provider choices injectable; avoid protocol-level vendor lock.
