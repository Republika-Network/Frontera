# Soberanía Protocol ↔ Frontera Systems Boundary

> STATUS: DRAFT — PENDING PROFESSIONAL LEGAL REVIEW.
> This document combines a technical description (derived from
> `docs/architecture/foundation.md`, `docs/architecture/protocol-integration.md`,
> `docs/architecture/repo-boundaries.md`, and `docs/enterprise/AOC_ENTERPRISE_HOST.md`)
> with a legal/commercial framing. Where the repository does not contain
> evidence for a claim (e.g. about Soberanía Protocol's own internal
> implementation, which lives in a separate repository this review did
> not access), this document says so rather than assuming.

## Summary

Soberanía Protocol and Frontera Systems are two separate projects with a
one-directional dependency: **Frontera Systems depends on Soberanía Protocol;
Soberanía Protocol does not depend on Frontera Systems.**

- **Soberanía Protocol** is a separate GitHub repository
  (`Architects-of-Change-Protocol/Architects_of_Change_Protocol`) that
  defines portable, implementation-agnostic security and governance
  primitives — identity contracts, capability token contracts, consent
  grant contracts, audit event envelope contracts, and scoped access
  grammar. It is described in this repository's own architecture docs
  as required to "remain product-neutral and enterprise-neutral."
- **Frontera Systems** (this repository) is the commercial orchestration,
  runtime, and operational layer that consumes Soberanía Protocol's published
  contracts via the `@aoc/protocol` package and builds a deployable,
  governable, auditable product on top of them.

This document describes Frontera Systems' side of that boundary, as
evidenced by this repository. It does not speak authoritatively for Soberanía
Protocol's own repository, governance, or licensing, which this review
did not access beyond what Frontera Systems' own docs and CI
configuration reveal.

## What belongs to Soberanía Protocol

Per `docs/architecture/protocol-integration.md`, Soberanía Protocol is the
"single source of truth" for:

- identity contracts
- capability token contracts
- consent grant contracts
- audit event envelope contracts
- scoped access grammar

Per `docs/architecture/foundation.md`, Soberanía Protocol "owns the normative
models for consent, scoped access, capability semantics, identity
claims, and audit events" and "must remain product-neutral and
enterprise-neutral."

## What belongs to Frontera Systems

Per the same documents, Frontera Systems owns orchestration contracts and
implementations for:

- `policy-runtime` (runtime policy decisions and enterprise guardrails)
- `tenant-governance`, `org-boundary` (tenant/org boundary management)
- `integration-runtime` (connector frameworks)
- `control-plane-sdk`, `enterprise-audit`, `agent-governance`
- the Soberanía Kernel (`src/kernel`), Frontera Systems Host (`src/enterprise`),
  and Frontera Systems Runtime (`src/runtime`) — the actual executable
  systems that operationalize protocol primitives.

These contracts are, per `protocol-integration.md`, "intentionally
interface-first and implementation-neutral" at the contract-definition
level, while the Kernel/Host/Runtime source trees contain the actual
executable implementation.

## What Enterprise consumes from Protocol

Frontera Systems imports protocol symbols from the canonical package entry
`@aoc/protocol` (never deep-imports protocol internals, per
`protocol-integration.md`). In this repository, the dependency is wired
as:

- `package.json` `peerDependencies`: `"@aoc/protocol": ">=0.1.0"`
- `package.json` `devDependencies`: `"@aoc/protocol": "file:../Architects_of_Change_Protocol/packages/protocol"` (local sibling-checkout link for development)
- `.github/workflows/publishability.yml`: CI clones
  `https://github.com/Architects-of-Change-Protocol/Architects_of_Change_Protocol.git`
  and builds `packages/protocol` from it as a real build-time dependency
  check
- `types/aoc-protocol/` and `tests/fixtures/protocol-stub/`: type-only
  fallbacks used when the sibling checkout is unavailable, so
  publishability validation does not require the full Soberanía Protocol
  checkout

This confirms Soberanía Protocol is consumed as a genuine external dependency,
not vendored or copied into this repository.

## What Enterprise implements

Per `docs/legal/IP_OVERVIEW.md` Section 2, the concrete implementations
that exist in this repository include: the Soberanía Kernel decision engine,
the Frontera Systems Host (HTTP API, persistence, events, telemetry,
health), the Frontera Systems Runtime (grants, delegation, vault,
federation), the Governance Store, the Assurance Runtime (Soberanía SAF
framework), the Evidence lifecycle, the Agent Passport Runtime, the
Enterprise Host SDK, tenant-isolation enforcement in the store layer,
transport adapters, and operational tooling (backup/restore/deployment).

## What Enterprise monetizes

Based on repository evidence, the monetizable surface is the Soberanía
Enterprise Host service (the API described by
`release/RELEASE_MANIFEST.json`'s 27-endpoint surface), its SDK, the
operational/deployment tooling around it, and product-specific
integrations such as `packages/pmfreak-agent-passport-foundation` and
the billing integration in `apps/agent-passport-web`. This repository
does not contain a formal pricing model, license-key/entitlement
enforcement mechanism, or metering implementation as of this writing —
none should be assumed to exist beyond what is coded here.

## What Enterprise operates

The Frontera Systems Host is designed to be run as a deployed service
(`scripts/run-enterprise-host.mjs`, `docs/operations/DEPLOYMENT_GUIDE_V1.md`),
with its own persistence (SQLite or in-memory), health/liveness/readiness
endpoints, structured logging, and telemetry counters. Soberanía Protocol, by
contrast, is not something this repository operates — it is a
compile-time dependency of Frontera Systems, not run as a separate service
by Frontera Systems, and not bundled into Frontera Systems' shipped runtime
artifacts (see the note on `validate-publishability.mjs` below).

## What a customer can deploy

A customer with a Commercial Agreement for Frontera Systems can deploy the
Frontera Systems Host (and, where licensed, the Enterprise Runtime, SDK,
and supporting tooling) as described in the deployment guide. Soberanía
Enterprise is built against Soberanía Protocol's published contracts at
compile time, but `scripts/validate-publishability.mjs` treats
`@aoc/protocol` as a **compile-time type dependency only** and
independently asserts, on every publishability run, that no shipped/
packed JS artifact imports `@aoc/protocol` at runtime. A customer
deployment of Frontera Systems' built artifacts therefore does not
necessarily include Soberanía Protocol's own code at runtime — only Enterprise
code that was type-checked against Protocol's contracts during the
build.

## What a customer does not get by acquiring Enterprise

Acquiring rights to Frontera Systems under a Commercial Agreement does
**not**, by itself:

- transfer ownership of, or any rights in, Soberanía Protocol or its
  repository;
- grant the right to modify, redistribute, or relicense Soberanía Protocol
  independent of whatever terms Soberanía Protocol's own project publishes;
- grant rights to Onchainfest LLC's trademarks (see `TRADEMARKS.md`)
  beyond what is expressly stated in the agreement;
- include source code access, unless source access is an explicit term
  of the Commercial Agreement (delivery may be as compiled/built
  artifacts, per `release/RELEASE_MANIFEST.json`'s artifact checksums).

## What requires a contract

The following require a written Commercial Agreement rather than being
available by default:

- production use, deployment, or redistribution of Frontera Systems;
- any sublicense or resale of Frontera Systems or derived services;
- use of Onchainfest LLC's trademarks in customer-facing materials;
- access to source code (as opposed to compiled artifacts), where
  applicable.

## Capability matrix

Where this repository contains no evidence either way for Soberanía
Protocol's own implementation (since that repository was not part of
this review), the "Soberanía Protocol" column reflects only what Soberanía
Enterprise's own documentation states about Protocol's role — not an
independent audit of the Protocol repository.

| Capacidad | Soberanía Protocol | Frontera Systems | Régimen | Evidencia | Observaciones |
|---|---|---|---|---|---|
| Specifications (primitive semantics) | Sí — owns normative models | No — consumes only | Protocol-owned; separate repo/license | `foundation.md`, `protocol-integration.md` | Enterprise imports via `@aoc/protocol` only |
| Primitives (consent-engine, capability-tokens, scoped-access, identity, audit-sdk) | Sí — canonical per `protocol-integration.md` | Reserved / not implemented (empty stub packages) | Protocol-owned; Enterprise-side stubs currently empty | `packages/consent-engine` etc. contain only `.gitkeep` | No redefinition currently exists because no Enterprise-side code exists; must remain consumption-only if implemented |
| Schemas (identity/token/consent/audit/scope contracts) | Sí — single source of truth | No — must import, not copy | Protocol-owned | `protocol-integration.md` | — |
| Governance concepts (abstract model) | Partial — defines primitive semantics | Sí — operationalizes into runtime decisions | Shared, layered | `foundation.md` §1 | Enterprise "may compose... cannot redefine primitive semantics" |
| Evidence formats | No evidence in this review | Sí — Evidence Bundle (`evidence.bundle.v1`) | Enterprise-owned | `docs/architecture/ADR-EVIDENCE-BUNDLE.md`, release manifest | No Protocol-side counterpart found in this review |
| Runtime (execution engine) | No — spec-only, product-neutral | Sí — Kernel, Enterprise Host, Enterprise Runtime | Enterprise-owned | `src/kernel`, `src/enterprise`, `src/runtime` | — |
| APIs (HTTP surface) | No | Sí — 27 documented endpoints | Enterprise-owned | `release/RELEASE_MANIFEST.json`, `docs/enterprise/AOC_ENTERPRISE_HOST.md` | Frozen v1 surface |
| Orchestration | No | Sí | Enterprise-owned | `foundation.md` §3 | — |
| Control plane | No | Partial — `packages/control-plane` has real logic; `control-plane-sdk` is contracts-only | Enterprise-owned | `packages/control-plane/src/service.ts` | Untested, not externally consumed as of this writing |
| Tenant management | No | Sí — isolation enforced in the store layer | Enterprise-owned | `docs/release/TECHNICAL_DUE_DILIGENCE_V1.md` §3 | `packages/tenant-governance` itself is contracts-only, not the enforcement logic |
| Deployment | No | Sí | Enterprise-owned | `docs/operations/DEPLOYMENT_GUIDE_V1.md` | Protocol is a compile-time dependency of Enterprise, not deployed separately by Enterprise and not bundled into shipped runtime artifacts (`scripts/validate-publishability.mjs` asserts no runtime import) |
| Adapters | No | Sí | Enterprise-owned | `src/enterprise/adapters`, `src/runtime/adapters` | — |
| Billing | No | Sí (integration only) | Enterprise-owned | `apps/agent-passport-web` (Stripe dependency) | Private demo app; not part of the shipped runtime deliverable |
| Metering | No evidence | No evidence found in this repository | Not implemented | — | Do not assume metering exists; none found |
| Support tooling | Out of scope for this repo | Sí | Enterprise-owned | `docs/operations/RUNBOOKS_V1.md`, `scripts/portability/**` | — |
| Observability | No | Sí (logs + health probes; no `/metrics` endpoint) | Enterprise-owned | `src/enterprise/telemetry` | Documented gap, not a defect |
| Assurance execution | No | Sí — Soberanía SAF framework | Enterprise-owned | `src/enterprise/assurance` | — |
| Identity implementation | Sí — owns primitive identity contracts | Reserved / not implemented as a dedicated package | Protocol owns the primitive; Enterprise-side dedicated package unimplemented | `packages/identity` contains only `.gitkeep` | Where/how identity claims are actually handled at runtime (e.g. inline in Kernel/Enterprise code vs. a dedicated module) was not fully traced in this review — flagged for engineering confirmation |
| Commercial integrations | No | Sí | Enterprise-owned | `packages/pmfreak-agent-passport-foundation`, `apps/agent-passport-web` | — |

## Dependency direction

- Frontera Systems may depend on public or versioned contracts published
  by Soberanía Protocol (currently `@aoc/protocol >=0.1.0`).
- Soberanía Protocol must not depend on Frontera Systems' proprietary code.
  Nothing in this repository grants Soberanía Protocol any such dependency,
  and none was found.
- Proprietary Enterprise extensions must not silently redefine the
  public protocol standard. This repository's own linting
  (`docs/architecture/protocol-integration.md` "Guardrails") is designed
  to catch protocol-primitive redefinition and deep protocol imports.
- Enterprise implementations must declare compatibility with specific
  protocol versions rather than assuming latest-always compatibility;
  today that is expressed as the semver range `>=0.1.0` in
  `package.json`, which should be tightened as both projects mature.

## Commercial rights

- Access to Soberanía Protocol (e.g., as an open resource, if and when Soberanía
  Protocol is made available on such terms by its own project) does
  **not** grant any rights to Frontera Systems. Frontera Systems' licensing
  is governed exclusively by `LICENSE` and any executed Commercial
  Agreement.
- Acquiring Frontera Systems under a Commercial Agreement does **not**
  transfer ownership of Soberanía Protocol, its source code, or its
  specifications, and does not transfer ownership of Frontera Systems'
  own source code either, unless an executed written agreement expressly
  says so.
- Where Soberanía Protocol has its own separate license, that license governs
  use of Soberanía Protocol directly; this document does not restate or
  supersede it, because this review did not have access to that
  repository's own license terms.
