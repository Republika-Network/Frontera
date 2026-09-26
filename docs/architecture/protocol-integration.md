# Frontera Systems + Soberanía Protocol Integration

## Purpose

This document defines how Frontera Systems consumes Soberanía Protocol primitives without redefining protocol semantics.

## Canonical ownership

AOC-Protocol is the **single source of truth** for:
- identity contracts
- capability token contracts
- consent grant contracts
- audit event envelope contracts
- scoped access grammar

AOC-Enterprise must import and orchestrate those primitives, not copy them.

## Enterprise orchestration ownership

AOC-Enterprise owns orchestration contracts for:
- policy-runtime
- tenant-governance
- org-boundary
- integration-runtime
- control-plane-sdk
- enterprise-audit
- agent-governance

These contracts are intentionally interface-first and implementation-neutral.

## Import strategy

- Import protocol symbols from the canonical package entry: `@aoc/protocol`.
- Do not deep-import protocol internals.
- Use explicit `.js` extensions for all relative imports/exports under Node16/NodeNext.
- Legacy `@/` aliases are forbidden in runtime packages.

## Contract boundaries

1. Protocol primitives remain canonical and product-neutral.
2. Enterprise contracts compose primitives with tenant/org/runtime context.
3. Applications should depend on enterprise facades instead of protocol internals when orchestration is required.

## Type strictness discipline

- `strict` and `exactOptionalPropertyTypes` remain enabled.
- Optional request fields must be conditionally attached (no `undefined` leakage into wire contracts).
- Prefer protocol or package-local explicit types over `any`.

## Guardrails

- No protocol primitive redefinition in enterprise packages.
- No runtime implementations in contract files.
- Keep schemas additive and minimally sufficient for orchestration.
- Guardrails run in linting to catch extensionless relative imports, deep protocol imports, and legacy aliases.
