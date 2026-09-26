# Frontera Systems ← Soberanía Protocol: Versioned Package Consumption

## Architecture

Frontera Systems consumes Soberanía Protocol exclusively as a **published package boundary**, never as source:

```text
Soberanía Protocol (packages/protocol, @aoc/protocol)
    ↓ versioned public package (peerDependency ">=0.1.0 || >=0.2.0-rc.0")
Frontera Systems (this repository)
    ↓ proprietary runtime and implementation
PMFreak
```

Enterprise imports only from the package specifier `@aoc/protocol` and its declared public
subpaths (`./contracts`, `./errors`, `./claims`, `./adapters`, `./runtime-registry`). It never
imports Protocol source files, `packages/protocol/src`, `dist` deep paths, or any relative path
into the `Architects_of_Change_Protocol` repository. `scripts/check-protocol-consumption.mjs`
enforces this on every CI run.

Soberanía Protocol is **not yet published to a registry**. Until it is, canonical compatibility between
the two repositories is proven with a **reproducible tarball built from a pinned Protocol commit**,
not by requiring both repositories to sit in sibling directories, and not by trusting a mutable
branch.

## Supported Protocol version

The commit and package version Enterprise is currently validated against are recorded in
[`protocol-consumer.lock.json`](../../protocol-consumer.lock.json) at the repository root. That
file — not this document — is the source of truth; re-read it before relying on the numbers below,
which are a point-in-time summary:

| Field | Value |
| --- | --- |
| Protocol repository | `Architects-of-Change-Protocol/Architects_of_Change_Protocol` |
| Protocol commit | see `protocol-consumer.lock.json` → `commit` |
| Protocol package | `@aoc/protocol` |
| Protocol package version | see `protocol-consumer.lock.json` → `expectedVersion` |
| Enterprise peer range | `package.json` → `peerDependencies["@aoc/protocol"]` (currently `>=0.1.0 \|\| >=0.2.0-rc.0`) |

`protocol-consumer.lock.json` is **not an npm lockfile**. It is a small, auditable, hand-updated
record of which Protocol artifact this repository has actually been validated against — the
cross-repository analogue of a commit pin.

### Burned candidate: `0.2.0-rc.0`

`@aoc/protocol@0.2.0-rc.0` (commit `dde34517…`, sha256 `dbe8a08f…`) is **BURNED and must never be
reinstated as the active pin.** Its canonical-JSON writer truncated exponent digits, so
`canonicalizeJSON(7.9e-10)` and `canonicalizeJSON(7.9e-100)` both produced `"7.9e-1"` — two distinct
numbers collapsing to one canonical form, and therefore one digest. Soberanía Protocol declared the
candidate burned rather than repacking its bytes, and cut `0.2.0-rc.1` from commit `eec79cdd…` as
the repaired successor, carrying the frozen integration contract from `1.0.0` to `1.0.1`. The
Protocol public export map did **not** move: 15 export keys, digest
`a67d65b17dcb34c7da84d9a07cb893e073e21e9edbbc621bcae649afa5cdeb45`, recomputed here from the packed
rc.1 artifact rather than copied from Protocol's evidence.

Frontera did not bundle the defect — the artifact ships no Protocol code, and `@aoc/protocol` is an
external peer dependency for every consumer. What the burn invalidated is Frontera's *compatibility
evidence*: candidates up to and including `1.2.0` were validated and handed off against an input
later declared burned. `vendor/aoc-protocol-0.2.0-rc.0.tgz`,
`docs/release/PROTOCOL_CONSUMPTION_EVIDENCE_0.2.0-rc.0.md` and every candidate manifest naming rc.0
are therefore left byte-identical: they are the honest record of what was true at the time.
`scripts/protocol/check-canonicalization-regression.mjs` (`npm run check:protocol-canonicalization`,
also run by `npm test`) fails the build if this repository ever resolves the burned candidate again.

## Local validation

Two scripts under `scripts/protocol/` reproduce the full consumption story locally, without
requiring the two repositories to be sibling checkouts:

1. **Build a reproducible tarball from a pinned commit:**

   ```bash
   # Option A — you already have a local Protocol checkout at the exact commit:
   AOC_PROTOCOL_REPO=/path/to/Architects_of_Change_Protocol \
     node scripts/protocol/build-protocol-tarball.mjs

   # Option B — fetch the exact pinned commit into a throwaway temp checkout:
   AOC_PROTOCOL_REPO=https://github.com/Architects-of-Change-Protocol/Architects_of_Change_Protocol.git \
     AOC_PROTOCOL_REF=<full 40-character commit SHA> \
     node scripts/protocol/build-protocol-tarball.mjs
   ```

   This validates repository/commit identity, runs `npm ci` + Protocol's own build, optionally runs
   Protocol's own consumer/package validation (`npm run protocol:consumer:check`; opt out with
   `AOC_PROTOCOL_SKIP_CONSUMER_CHECK=true`), packs `packages/protocol` with `npm pack`, computes a
   SHA-256 of the tarball, and prints a JSON result (repository, commit, package, version, tarball
   path, checksum). It never publishes anything and cleans up any temporary checkout it created.

2. **Validate Enterprise against that tarball, in isolation:**

   ```bash
   node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs <path-to-tarball>
   ```

   This copies the Enterprise repository into a throwaway temp directory (excluding `.git`,
   `node_modules`, `dist`, `coverage`, and other build artifacts), points its `@aoc/protocol`
   devDependency at the tarball via an absolute `file:` path, deletes the copy's lockfile so npm
   resolves fresh, narrows the local TypeScript ambient shim down to *only* the documented export
   gap (see "Known gaps" below — every other symbol resolves against the real installed tarball),
   runs `npm install`, and then runs the full validation battery (`typecheck`, `build`, `lint`,
   `test`, `check:protocol-consumption`, `check:aoc-boundaries`, `validate:publishability`,
   `check:release-integrity`) inside that isolated copy. It additionally scans for forbidden deep
   imports, sibling-path leakage in the resulting lockfile/`node_modules`, and declaration files
   that leak local filesystem paths. It never touches the real repository's `package.json` or
   `package-lock.json`, and it deletes the temp copy on exit (success or failure).

3. **Validate the compatibility lock itself:**

   ```bash
   node scripts/protocol/check-compatibility-lock.mjs
   ```

   Checks that `protocol-consumer.lock.json` is well-formed and internally consistent (full commit
   SHA, exact repository slug, exact package name, non-empty verified export list, a well-formed
   SHA-256 tarball checksum).

The root `package.json` exposes these as `npm run protocol:tarball:build` and
`npm run protocol:tarball:validate` (see that file for exact invocations).

## CI validation

`.github/workflows/publishability.yml` builds a pinned-commit tarball (reading the commit from
`protocol-consumer.lock.json`) inside the CI runner's own temp space, then runs
`scripts/protocol/validate-enterprise-against-protocol-tarball.mjs` against it — the same isolated,
tarball-backed validation described above, on every pull request and push to `main`/`master`. It
does **not** clone Protocol into a fixed sibling path, does **not** trust a mutable branch, does
**not** publish anything, does **not** use an npm publish token, and does **not** create a release
or tag. This job is **blocking** (`continue-on-error` was removed once the Protocol Contract
Adoption sprint resolved every documented gap — see "Known gaps" below). `.github/workflows/ci.yml`
(typecheck/build/lint/test/legal) is unaffected — it has never required the Protocol sibling
checkout, because `package.json`'s `@aoc/protocol` devDependency now points at the vendored,
checksummed tarball (`vendor/aoc-protocol-0.2.0-rc.1.tgz`), which is a real, tracked file, not a shim.

## Allowed imports

Enterprise source may import only:

- `@aoc/protocol`
- `@aoc/protocol/contracts`
- `@aoc/protocol/errors`
- `@aoc/protocol/claims`
- `@aoc/protocol/adapters`
- `@aoc/protocol/runtime-registry`

As of this sprint, Enterprise's own source only actually consumes the root specifier
(`@aoc/protocol`) — note that Protocol's `package.json` `"main"`/`"exports"["."]` and
`exports["./contracts"]` point at the identical build output, so this is not a behavioral gap, just
an unused-subpath fact worth knowing. Deep imports (`@aoc/protocol/src/*`, `@aoc/protocol/dist/*`,
`@aoc/protocol/internal/*`), relative imports into the Protocol repository, and any other
undeclared subpath are rejected by `scripts/check-protocol-consumption.mjs` and
`scripts/check-node16-imports.mjs`.

## Known gaps

**None.** As of the Protocol Contract Adoption sprint, `protocol-consumer.lock.json`'s `knownGaps`
is an empty array (see its `resolvedGaps` for how each was closed). The three gaps discovered by an
earlier sprint's isolated tarball validation are resolved:

| # | Former finding | Resolution |
| --- | --- | --- |
| 1 | `AocIdentityClaims` did not exist in the real package at all | Replaced everywhere by the Enterprise-owned `VerifiedActorClaims` (`@aoc-enterprise/identity`, `{ readonly sub: string }`), imported by all 8 real consumer files (`src/runtime/context.ts`, `src/adapters/protocol-adapters.ts`, `src/runtime/authorization/evaluators/authorization-evaluator.ts`, `packages/agent-governance/src/contracts.ts`, `packages/tenant-governance/src/contracts.ts`, `packages/integration-runtime/src/contracts.ts`, `packages/control-plane-sdk/src/contracts.ts`, `packages/policy-runtime/src/contracts.ts`). Zero imports of `AocIdentityClaims` from `@aoc/protocol` remain; enforced by `scripts/check-protocol-contract-adoption.mjs`. |
| 2 | `ScopedAccessRequest` shape mismatch: Enterprise read `.scope`/`.action`; the real type has neither | `packages/control-plane/types.ts` and `src/runtime/host.ts` migrated to the real `.requestedScope`. `.action` moved to the Enterprise-owned `EnterpriseScopedAccessRequest` extension (`@aoc-enterprise/scoped-access`), which composes (does not duplicate) the real `ScopedAccessRequest`. `resource` (real: `ResourceRef`) is compared via the explicit `legacyResourceIdentifier()` accessor, not a cast. Enterprise's own persisted field names (e.g. `requested_scope`) are unchanged. |
| 3 | `AuditEventEnvelope` field-naming divergence | `ControlPlaneAuditEvent` is now a standalone, Enterprise-owned legacy type (no longer `AuditEventEnvelope & {...}`). `packages/control-plane/audit-envelope-mapper.ts`'s `toProtocolAuditEventEnvelope()` is the sole, explicit, field-by-field mapping boundary. `.aoc-control-plane.json`'s persisted shape and `ControlPlaneService`'s existing public API are unchanged. |

`scripts/check-protocol-consumption.mjs` no longer allowlists any ambient shim in the main tree or
the external-consumer fixture — the only remaining allowlisted stand-in is
`tests/fixtures/protocol-stub/index.d.ts`, a documented fallback used only by
`scripts/validate-publishability.mjs` when neither the vendored tarball nor a sibling checkout can
be found on disk.

## Dependency mechanism (canonical, not a shim)

`package.json` → `devDependencies["@aoc/protocol"] = "file:./vendor/aoc-protocol-0.2.0-rc.1.tgz"`. This
is a real, tracked, checksummed npm tarball (see `vendor/README.md`, `protocol-consumer.lock.json`),
not a sibling-directory reference and not an ambient shim — `npm install`/`npm ci` extract it into a
real `node_modules/@aoc/protocol` (confirmed not a symlink), and `tsconfig.base.json` has no `paths`
override for `@aoc/protocol` at all, so TypeScript resolves it exactly the way any real consumer's
`tsc` would. This is the canonical interim mechanism while `@aoc/protocol` remains unpublished (see
"Registry transition" below); it works identically in CI and in a fresh clone, with no dependency on
a Protocol sibling checkout being present.

## Prerelease peer compatibility

`@aoc/protocol@0.2.0-rc.0` is a **prerelease**. npm's semver deliberately excludes prereleases from
any range whose comparators carry no prerelease of the same `major.minor.patch` tuple, so:

```js
semver.satisfies('0.2.0-rc.0', '>=0.1.0')   // false
```

This is not a compatibility statement about Enterprise — `0.2.0-rc.0` sorts *above* `0.1.0` — it is
a mechanical property of range matching. Left uncorrected it is not cosmetic: an external consumer
installing `@aoc-enterprise/runtime` alongside the frozen candidate fails hard.

```text
npm error code ERESOLVE
npm error Found: @aoc/protocol@0.2.0-rc.0
npm error Could not resolve dependency:
npm error peer @aoc/protocol@">=0.1.0" from @aoc-enterprise/runtime@1.0.0
```

The peer range is therefore stated as `>=0.1.0 || >=0.2.0-rc.0`. The added clause is deliberately
the narrowest expression that admits the frozen candidate, and it is **not** a widening of stable
compatibility:

| Protocol version | `>=0.1.0` | `>=0.1.0 \|\| >=0.2.0-rc.0` |
| --- | --- | --- |
| `0.1.0`, `0.1.5`, `0.2.0`, `0.3.0`, `1.0.0`, `2.0.0` | satisfied | satisfied (unchanged) |
| `0.0.9` | not satisfied | not satisfied (unchanged) |
| `0.2.0-rc.0`, `0.2.0-rc.1` | not satisfied | **satisfied (newly admitted)** |
| `0.2.0-alpha.1`, `0.2.0-beta.9` | not satisfied | not satisfied (unchanged) |
| `0.1.0-rc.1`, `0.3.0-rc.0`, `1.0.0-rc.1` | not satisfied | not satisfied (unchanged) |

No stable version changes status, and no prerelease family other than the frozen `0.2.0` `rc` line
is admitted. `scripts/check-protocol-consumption.mjs` still asserts the range is an explicit semver
range (not `*`, not `file:`), so this does not weaken that gate.

The repin from the burned `0.2.0-rc.0` to the repaired `0.2.0-rc.1` therefore required **no change
to this range**: `semver.satisfies('0.2.0-rc.1', '>=0.1.0 || >=0.2.0-rc.0')` is already `true`, and
re-expressing the range to name `rc.1` would admit nothing new while discarding a validated
expression. The table above was re-verified mechanically before the range was left alone.

When Protocol cuts a stable `0.2.0`, the `|| >=0.2.0-rc.0` clause should be dropped again — it
exists to express a candidate relationship, not a permanent one.

## Upgrade procedure

1. Build a new tarball from the target Protocol commit:
   `AOC_PROTOCOL_REPO=<url> AOC_PROTOCOL_REF=<new full commit SHA> node scripts/protocol/build-protocol-tarball.mjs`.
2. Run `node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs <tarball path>` and
   confirm every step passes.
3. Review the diff in Protocol's public exports between the previously-pinned commit and the new
   one. `KNOWN_EXPORT_GAPS` in `scripts/protocol/validate-enterprise-against-protocol-tarball.mjs`
   is currently `{}` (no known gaps); if the new commit removes or renames an export Enterprise
   depends on, add the gap there and to the "Known gaps" table above, and open a follow-up to
   migrate the affected call sites.
4. Run the full release gate locally (`npm run validate:release`, and `npm run validate:v1-release`
   when cutting a release).
5. Update `protocol-consumer.lock.json` with the new commit, tarball filename, and SHA-256, and run
   `node scripts/protocol/check-compatibility-lock.mjs` to confirm it is well-formed.
6. Open a PR. CI re-runs the same isolated tarball validation independently.
7. Merge only once CI is green. Do not publish `@aoc/protocol` or `@aoc-enterprise/runtime`, create a
   release, or create a tag as part of this procedure.

## Rollback

Revert `protocol-consumer.lock.json` to the previously-validated commit/tarball checksum (git
history is the audit trail — every change to this file should be its own commit), then re-run
`node scripts/protocol/validate-enterprise-against-protocol-tarball.mjs` against a freshly-built
tarball of that prior commit to confirm the rollback target still validates cleanly.

## Registry transition

Soberanía Protocol is **not currently published** to any npm registry, GitHub Packages, or equivalent.
This sprint's tarball-from-pinned-commit flow is an explicit interim measure. Once Protocol
publishes a prerelease, this repository's canonical validation should move to installing
`@aoc/protocol` from that registry at an exact version or governed semver range, and the tarball
flow becomes a fallback/offline-development path rather than the CI-canonical one. That migration
is out of scope for this sprint and does not happen automatically.
