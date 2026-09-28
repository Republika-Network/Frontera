# Governed Parameter Runtime (CORE-03)

> **Money is one parameter dimension. It does not define the governed-action model.**

A pure primitive — no imports, no I/O, no clock — that every layer may use:

- **Semantic identifiers** — one grammar for dimension ids, action classes,
  resource classes and Governance Profile ids; case-only duplicates refused.
- **Typed values** — `integer` (safe, never `-0`), `token`, `boolean`. Parsed by
  the *declared* type; nothing is coerced.
- **Typed bounds** — `exact` (any type) and `maximum` (integer), with total,
  exact comparisons; different kinds or types are `incomparable` (fail closed).
- **Dimension registry** — `{ id, type, bound }`, declared once by trusted
  configuration. Closed for authority, extensible for domains.
- **Semantics** — `GovernedActionSemantics { actionClass, resourceClass,
  governanceProfile: { id, version, digest } }` and the one profile reference
  string `<id>@<version>#<digest>`.

What it deliberately is not: a taxonomy (no action or resource enum), a policy
language (no expressions), or a money model (`amount` stays P9's
`MonetaryAmount`). See `docs/architecture/ADR-GOVERNED-ACTION-SEMANTIC-PARAMETER-MODEL.md`.
