# ADR: Enterprise Host Naming

## Status

Accepted.

## Context

- `src/runtime/` already exists in this repository. It implements
  `createAocEnterpriseRuntime` (`AocEnterpriseRuntime`): execution grants,
  delegated capabilities, capability claims, vault boundaries, and
  federation envelopes. It has its own composition root, its own ports
  (`RuntimePortSet`), and its own test suite. It does not call
  `AocKernel.evaluate()` anywhere -- a repository-wide search for
  `kernel`/`AocKernel` inside `src/runtime/**` returns no hits.
- PR-002 built a new HTTP layer that hosts `AocKernel` as a production
  service (`POST /api/governance/evaluate`, `GET /health`, persistence,
  events, telemetry). It was placed at `src/kernel-host/` specifically to
  avoid colliding with `src/runtime/`'s existing, unrelated meaning.
- Calling both layers some variant of "Runtime Host" would create real
  ambiguity: `src/runtime/`'s own package.json export subpath is literally
  named `./runtime-host` already (pointing at `src/runtime/index.js`),
  despite never hosting the Kernel.
- Calling the new layer "Kernel Host" was accurate for PR-002's scope but
  too narrow for its known long-term trajectory: it is expected to
  eventually own persistence, audit, telemetry, API/SDK adapters, provider
  composition, and integration points for Passport, Evidence, Jurisdiction,
  and Constitutional subsystems -- none of which are "the Kernel" per se.

## Decision

- Preserve `src/runtime/` exactly as-is: not moved, renamed, merged,
  rewritten, routed through the Kernel, deprecated, or altered in its
  exports.
- Rename `src/kernel-host/` to `src/enterprise/`.
- Adopt **Frontera Systems Host** as the public architectural term for this
  module, and `AocEnterprise` / `createEnterprise()` as its primary
  TypeScript symbols.
- Make the Enterprise Host layer's `createEnterprise()` the one formal
  composition boundary a caller uses to obtain a working instance --
  `AocEnterprise.evaluate()`/`.health()` is the stable application-level
  interface both the HTTP server and any future embedding consume.
- Keep the Kernel (`src/kernel/`) fully independent: it is never aware of,
  and never imports, the Enterprise Host or `src/runtime/`.

## Consequences

**Positive:**
- Clearer ownership: three distinctly-named layers (`kernel`, `runtime`,
  `enterprise`) each with an unambiguous, documented responsibility.
- Reduced name collision with `src/runtime/`'s pre-existing `./runtime-host`
  export and its own "Runtime Host" framing in its docs/examples.
- Room for the Enterprise layer to grow into its actual long-term role
  (persistence, audit, provider composition, plugin hosting in PR-003)
  without a second rename later.
- No disruption to `src/runtime/`'s mature, independently-tested grants/
  delegation/vault/federation behavior -- verified by a structural-boundary
  test (`src/enterprise/__tests__/structural-boundaries.test.ts`) that fails
  the build if `src/runtime/` ever imports the Enterprise Host or vice
  versa.

**Negative:**
- Migration cost: every symbol PR-002 introduced with a `Runtime*` prefix
  needed a mechanical rename to `Enterprise*` (see
  `docs/enterprise/KERNEL_HOST_TO_ENTERPRISE_MIGRATION.md`).
- A temporary compatibility alias (`src/kernel-host/index.ts` re-exporting
  `src/enterprise/index.js`) must be carried until no known consumer
  depends on the old path.
- Documentation needed updating in multiple places
  (`docs/runtime/ENTERPRISE_RUNTIME_HOST.md` -> `docs/enterprise/AOC_ENTERPRISE_HOST.md`,
  plus this ADR and the migration guide).
- One more architectural layer name for new contributors to learn
  (`kernel` vs. `runtime` vs. `enterprise`), though each is now
  unambiguously scoped.

## Rejected alternatives

- **Rewrite `src/runtime` to route through the Kernel.** Would have made
  "Runtime Host" literally accurate, but `src/runtime/` is mature,
  independently tested, and solves a genuinely different problem
  (grants/delegation/vault/federation, not governance evaluation).
  Rewriting it would be a governance-logic change and a large, unrelated
  behavioral risk for what is meant to be a naming/composition iteration.
- **Repoint the existing `./runtime-host` package export** to the new
  Kernel-hosting module instead of introducing `./enterprise`. Rejected
  because it would silently change what `./runtime-host` resolves to for
  any existing consumer of `src/runtime/`'s own docs/examples that already
  reference that subpath, without any deprecation signal.
- **Keep `kernel-host` as the permanent name.** Rejected: accurate today,
  systematically wrong once persistence/audit/telemetry/API/SDK/provider
  composition and Passport/Evidence/Jurisdiction/Constitutional integration
  land, per the mission's own stated trajectory for this layer.
- **Merge Runtime and Enterprise immediately.** Rejected as premature and
  out of scope: no requirement in this iteration calls for one system to
  subsume the other, and doing so speculatively would violate "do not
  redesign working behavior."
