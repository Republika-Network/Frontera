# Frontera ← Soberanía runtime: pinned artifacts for the private pilot

Status: **package integration only** (FRONTERA-SOBE-PILOT-01A). Frontera vendors and qualifies a small
set of Soberanía runtime packages. No Frontera source consumes them yet, they are not installed into
Frontera's dependency graph, and nothing here changes the Kernel, the Host, authentication, payments,
evidence or deployment configuration. Wiring the runtime into the Kernel as a deny-only port is a
separate, later increment.

## What is vendored

`soberania-runtime-consumer.lock.json` is the source of truth; `vendor/soberania-runtime/` holds the
artifacts it pins. All come from `Republika-Network/Soberania_Protocol` at commit
`1112c63d93875400aeae8e01d85f3c8543be51d4`, packed with `npm pack` from a clean checkout after
`npm ci` and `npm run build` (the build reproduces the committed `dist/` byte for byte; a second pack is
byte-identical). Nothing is published to a registry.

| Package | Role | Runtime requires |
| --- | --- | --- |
| `@aoc-runtime/authorization-runtime` | runtime | nothing (its imports are type-only) |
| `@aoc-runtime/governance-runtime` | runtime | `@aoc-runtime/crypto` |
| `@aoc-runtime/capability-runtime` | runtime | nothing |
| `@aoc-runtime/consent-runtime` | runtime | `@aoc-runtime/crypto` |
| `@aoc-runtime/crypto` | runtime | `@aoc/protocol/canonical`, `node:crypto` |
| `@aoc-runtime/provider-interfaces` | declarations | nothing; never loaded at runtime |
| `@aoc-runtime/shared-types` | declarations | nothing; never loaded at runtime |

All seven are CommonJS with a single `"."` export. `@aoc/protocol/canonical` comes from the pinned
`@aoc/protocol` 0.2.0-rc.3 and remains an internal dependency only (see
`PROTOCOL_PACKAGE_CONSUMPTION.md`): Frontera source still may not import it.

## What is excluded

The root package `aoc-runtime` (not certified for distribution), `@aoc-runtime/trust-registry-runtime`,
`@aoc-runtime/audit-runtime` and `@aoc/enterprise` (which carries the trust-service and payout-KYC
surface), Portable Cognition, the vault runtime and the PMFreak adapter. The HMAC capability-token path,
payouts, federation and the hosted HTTP runtime are not part of any vendored package's runtime closure.
`scripts/soberania-runtime/lib-runtime-artifacts.mjs` fixes the approved and excluded sets in code, so a
lock edit cannot widen them.

## Runtime contract facts the integration must respect

These were observed from the packaged artifacts and are asserted by
`tests/soberania-runtime-consumption.test.mjs`:

- **Decisions.** `AuthorizationRuntime` evaluates policy, then governance, capability and consent, and
  denies at the first failing stage. Governance is deny-by-default: with no matching rule the decision
  is not an allow.
- **Consent** counts only grants signed by the resource owner's trusted key (and, for a delegated grant,
  countersigned by the delegate); the owner comes from a `ResourceOwnershipProvider`, never from the
  grant. Revocation and expiry markers deny.
- **Clocks.** Consent reads the evaluation time from `at`; capability reads it from `now`, falling back
  to the wall clock. An integration must pass the same trusted server time as both. Any non-ISO-8601
  timestamp denies.
- **Provider failures.** An ownership provider that throws or does not answer denies. A policy,
  capability or consent provider that throws makes `evaluate()` reject instead of returning a decision:
  this fails closed only if the caller treats a rejection as a denial.
- **Federation** is off: a federated-authority input without a configured verifier denies.
- **Audit.** `AuthorizationRuntime` requires an object with `finalizeDecision()`. Soberanía's
  implementation lives in the excluded `@aoc/enterprise`; it only annotates an already-final decision.
  The consumption test uses a pass-through.

## Declaration gap

`@aoc-runtime/authorization-runtime`'s declarations import types from the excluded
`@aoc-runtime/audit-runtime` and `@aoc-runtime/trust-registry-runtime`. With Frontera's
`skipLibCheck: true` a strict consumer compiles, but the audit and federated-authority types read as
`any`; without `skipLibCheck` the two imports fail to resolve. The compiled module requires neither.
This is recorded in the lock (`declarationGaps`) and is an input to the Kernel integration increment.

## Checks

- `npm run check:soberania-runtime-lock` — lock policy, every artifact's bytes, checksums, size and file
  inventory, no unpinned artifact in `vendor/soberania-runtime/`, and no Frontera source importing the
  runtime.
- `tests/soberania-runtime-consumption.test.mjs` (run by `npm test`) — the same, plus a plain-Node
  scenario run from a temporary directory containing only the extracted artifacts and the installed
  `@aoc/protocol`.
- `scripts/protocol/validate-enterprise-against-protocol-tarball.mjs` copies
  `vendor/soberania-runtime/*.tgz` into its isolated copy (Protocol tarballs remain excluded there).

## Updating

Repack from a new pinned commit with the method above, replace the artifacts, regenerate every field of
the lock from the new tarballs, and re-run the checks. Never edit an artifact in place.
