# `@aoc-enterprise/soberania-runtime-closure`

Private workspace, no code. Its only job is to make the approved Soberanía runtime closure a real
production dependency of the Host (FRONTERA-SOBE-PILOT-01C0):

- `@aoc-runtime/authorization-runtime`, `governance-runtime`, `capability-runtime`,
  `consent-runtime`, `crypto` — the five executable runtimes;
- `@aoc-runtime/provider-interfaces`, `shared-types` — their declaration packages;
- `@aoc/protocol` — the pinned candidate, because `@aoc-runtime/crypto` requires
  `@aoc/protocol/canonical` at run time.

Each is installed from the vendored, lock-verified tarball (`soberania-runtime-consumer.lock.json`,
`protocol-consumer.lock.json`). Because these are this workspace's production dependencies, the Host
image's `npm ci --omit=dev --include-workspace-root --workspace=packages/*` installs them.

What this workspace deliberately is not:

- **Not a consumer.** No Frontera source imports the runtime yet; `npm run check:soberania-runtime-lock`
  fails if one does.
- **Not part of the published artifact.** `@aoc-enterprise/runtime` neither depends on nor bundles it,
  so the artifact keeps the shape ADR-FRONTERA-SELF-CONTAINED-PACKAGING records: `@aoc/protocol` an
  external peer, never bundled.
- **Not a place for other dependencies.** The runtime lock check rejects any dependency outside the
  approved closure, any dev, peer or optional dependency, and any code entry point.

Where the runtime is finally consumed, and how the published artifact carries it, is decided with the
Soberanía authorization adapter in FRONTERA-SOBE-PILOT-01C1. See
`docs/integration/SOBERANIA_RUNTIME_CONSUMPTION.md`.
