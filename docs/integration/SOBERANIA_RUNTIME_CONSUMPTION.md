# Frontera ← Soberanía runtime: pinned artifacts for the private pilot

Status: **dependency and contract integration only** (FRONTERA-SOBE-PILOT-01A, extended by
FRONTERA-SOBE-PILOT-01C0). Frontera vendors and qualifies a small set of Soberanía runtime packages and,
since 01C0, installs them as production dependencies (see *Installation*). No Frontera source consumes
them yet, and nothing here changes the Kernel, the Host, authentication, payments, evidence or deployment
configuration. The Kernel's optional deny-only external authorization port (FRONTERA-SOBE-PILOT-01B)
stays unconfigured; the Soberanía authorization adapter that would answer it is FRONTERA-SOBE-PILOT-01C1.

## What is vendored

`soberania-runtime-consumer.lock.json` is the source of truth; `vendor/soberania-runtime/` holds the
artifacts it pins. All come from `Republika-Network/Soberania_Protocol` at commit
`e85cf1bbb76e844fee7ff6ad5dd5389d26a5f180` (the squash merge of PR #396, SOBE-TYPES-01), packed with
`npm pack` from a clean checkout after `npm ci` and `npm run build` (the build reproduces the committed
`dist/` byte for byte; two independent clean reproductions are byte-identical). Relative to the 01A pin
(`1112c63`), only `@aoc-runtime/authorization-runtime` changed — its declarations, not its
`dist/index.js` — and the other six repack byte-identically. Nothing is published to a registry.

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
- **Audit.** `AuthorizationRuntime` requires an `AuthorizationDecisionFinalizer`
  (`finalizeDecision<T>(decision: T): T`). Soberanía's implementation lives in the excluded
  `@aoc/enterprise`; it only annotates an already-final decision. The tests use a pass-through that is
  explicitly a **non-production test fixture**: it signs and records nothing and is not audit evidence.
  A production finalizer is FRONTERA-SOBE-PILOT-01C1 scope.
- **Typing the clock and expiry.** `AuthorizationInput` declares `at` but not `now`, although
  `CapabilityRuntime` reads `now` from the same object; `CapabilityRef` declares no `expiresAt`, although
  `CapabilityRuntime` honours it. A typed caller states both with an intersection type (see the strict
  consumer fixture); an adapter that omits `now` silently evaluates capability expiry against the wall
  clock.

## Declarations

Until 01C0, `@aoc-runtime/authorization-runtime`'s declarations imported types from the excluded
`@aoc-runtime/audit-runtime` and `@aoc-runtime/trust-registry-runtime`, so they did not type-check without
`skipLibCheck`. Soberanía PR #396 replaced those imports with structural ports declared in the package
(`AuthorizationDecisionFinalizer`, `FederatedAuthorityVerifierPort`). The installed declarations now
import only approved closure packages, and a strict consumer (`strict`, `skipLibCheck: false`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) compiles with no `any`, assertion or ambient
module declaration. The lock records this under `resolvedDeclarationGaps`.

## Installation

The private workspace `packages/soberania-runtime-closure` holds no code. Its production dependencies are
the seven vendored tarballs and `@aoc/protocol` (the same artifact the root pins), so `package-lock.json`
records the closure — and `@aoc/protocol`, which `@aoc-runtime/crypto` requires at run time — as
production packages, and the Host image's `npm ci --omit=dev --include-workspace-root
--workspace=packages/*` installs them.

The root package's dependencies are deliberately unchanged. Declaring the closure there would force the published
`@aoc-enterprise/runtime` artifact either to bundle it or to carry `file:` specifiers that no consumer can
resolve, and moving `@aoc/protocol` into root `dependencies` would turn the external peer recorded by
ADR-FRONTERA-SELF-CONTAINED-PACKAGING into a hard dependency (npm rejects the alternative, an override of
the peer, with `EOVERRIDE`). Where the runtime is consumed, and how the published artifact carries it, is
decided with the Soberanía authorization adapter in 01C1.

## Checks

- `npm run check:soberania-runtime-lock` — lock policy, every artifact's bytes, checksums, size and file
  inventory, no unpinned artifact in `vendor/soberania-runtime/`, no Frontera source importing the
  runtime, only the closure workspace declaring it (exactly the approved set, its `@aoc/protocol` the
  root's artifact), and `package-lock.json` installing exactly the locked artifacts, once, as production
  packages, with nothing excluded anywhere.
- `tests/soberania-runtime-consumption.test.mjs` (run by `npm test`) — the same, plus: the plain-Node
  scenario from a temporary directory containing only the extracted artifacts and the installed
  `@aoc/protocol`; the installed `node_modules` byte-identical to the artifacts; npm refusing a
  substituted tarball (`EINTEGRITY`); the strict TypeScript consumer (compile, seven negative type
  controls, typed allow/deny/reject cases, loaded-module closure); and the Kernel's external
  authorization port configured nowhere outside the Kernel.
- `npm run qualify:soberania-runtime-closure` — the Host's production install (`npm ci --omit=dev`, the
  Dockerfile command) in a clean export, then the scenario executed from the installed tree with
  `vendor/`, `src/` and `tests/` deleted. Not part of `npm test` (it reinstalls the repository). It installs
  from a `git` export, so the container build context (`.dockerignore`, which must admit
  `vendor/soberania-runtime/*.tgz`) is covered by the pilot deployment qualifications instead.
- `scripts/protocol/validate-enterprise-against-protocol-tarball.mjs` copies
  `vendor/soberania-runtime/*.tgz` into its isolated copy (Protocol tarballs remain excluded there) and
  points both the root devDependency and the closure workspace's `@aoc/protocol` at the tarball under
  validation.

## Updating

Repack from a new pinned commit with the method above, replace the artifacts, regenerate every field of
the lock from the new tarballs, run `npm install` so `package-lock.json` records the new integrity, and
re-run the checks. Never edit an artifact in place.
