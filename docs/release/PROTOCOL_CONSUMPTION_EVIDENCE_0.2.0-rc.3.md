# Protocol Consumption Evidence — `@aoc/protocol@0.2.0-rc.3` (FRONTERA-SOBE-PILOT-01A0)

**Status: NOT PUBLISHED.** No `npm publish`, no registry configuration, no dist-tag, no git tag, no
GitHub Release, no merge. Both packages remain `private: true`. This document records what was
verified; it authorizes nothing.

This is the candidate-specific companion to
[`PROTOCOL_CONSUMPTION_EVIDENCE_0.2.0-rc.1.md`](./PROTOCOL_CONSUMPTION_EVIDENCE_0.2.0-rc.1.md), which
is left byte-identical. `0.2.0-rc.1` is **superseded, not burned**: no defect is recorded against it.
`0.2.0-rc.3` is Soberanía Protocol's security release candidate (issuer verification bound to the
signed issuer's registered key) and is the input the approved Soberanía runtime integration is
validated against.

## Protocol input — independently verified here

| Field | Expected | Verified |
| --- | --- | --- |
| Package | `@aoc/protocol` | yes |
| Version | `0.2.0-rc.3` | yes |
| `private` | `true` | yes |
| Source commit | `fd705f689e04781748e308368a10e52ae32af079` | yes |
| Tarball | `aoc-protocol-0.2.0-rc.3.tgz` | yes |
| SHA-256 | `3d17beff5a0538172f3d888184459511c44540332ccde51a30da32afa1b358f4` | yes |
| SHA-512 | `62b864de877004ea7c96638d4d34a22e268806e23e6a85e0891612bf8d0889e3b45a545ac3c087404902dd729dd50eb823257e0377666a36bf05bdaa59d3632f` | yes |
| npm integrity | `sha512-Yrhk3odwBOp8lmONTTSiLiaIBuI+aoXgiRYSv40IieO0WlRaw8CHQEkC3XKd1Q64IyV+A3dmaja/Bb2qWdNjLw==` | yes |
| Size | 288,728 bytes | yes |
| File count | 410 | yes |
| Exports fingerprint | `a67d65b17dcb34c7da84d9a07cb893e073e21e9edbbc621bcae649afa5cdeb45` (15 keys, unchanged from rc.1) | yes |
| Integration contract | `aoc.cross-repository-integration@1.0.3`, `frozen` | yes |

### How it was obtained

`scripts/protocol/build-protocol-tarball.mjs` with `AOC_PROTOCOL_REF=fd705f689e04781748e308368a10e52ae32af079`
and the default repository URL: a temporary checkout, `npm ci`, Protocol's own build, Protocol's own
`protocol:consumer:check` (passed), `npm pack`. The recorded slug
`Architects-of-Change-Protocol/Architects_of_Change_Protocol` answered HTTP 301 to
`Republika-Network/Soberania_Protocol` on 2026-10-26; the lock's `repository` field is not renamed.

### Provenance

- The Protocol source tag `source/aoc-protocol-0.2.0-rc.3` (tag object `cb2b0a52…`, annotated,
  **unsigned**, protected by the source repository's tag ruleset) points at `fd705f68`, the
  release-preparation commit.
- `fd705f68` is not on Protocol `main`: the release was squash-merged as `3cb635db`. `packages/protocol`
  is the identical tree object (`12a41cb0…`) at `fd705f68`, `3cb635db` and Protocol `main`
  `1112c63d`, so the packed artifact does not depend on which is built.
- Every value in the table equals Protocol's own
  `docs/release/evidence/aoc-protocol-0.2.0-rc.3-release-manifest.json` and
  `aoc-protocol-0.2.0-rc.3-consumer.lock.json`, and the SHA-256 equals an independent post-merge double
  pack of Protocol `main` `1112c63d`.

### Exports fingerprint

Recomputed from the packed artifact's own `package.json` (sha256 of the canonically ordered `exports`
entries, Protocol's `scripts/fingerprint-public-surface.mjs` method). The same computation over the
vendored rc.1 artifact reproduces the value previously recorded, so the method is confirmed rather
than assumed.

## Public-surface review (upgrade procedure step 3)

The export map is unchanged and `package.json` differs only in `version`. Content changes against rc.1
are confined to `dist/manifest/*` (issuer binding; additive `deriveSovereignKeyId`,
`digestCanonicalBytes`), `dist/sovereignty-capabilities/*` (issuer narrowing), a new
`dist/canonical/snapshot.*`, and `integration-contract.json`. Frontera source imports none of these
subpaths, so `KNOWN_EXPORT_GAPS` stays `{}` and `knownGaps` stays empty.

## Peer range: deliberately unchanged

`semver.satisfies('0.2.0-rc.3', '>=0.1.0 || >=0.2.0-rc.0')` is `true` (re-verified mechanically);
`0.3.0-rc.0` and `0.2.0-beta.9` remain excluded. As with the rc.1 repin, re-expressing the range would
admit nothing new.

## Internal dependency: `@aoc/protocol/canonical`

Founder decision for FRONTERA-SOBE-PILOT-01A0: `@aoc/protocol/canonical` is permitted only as an
internal dependency of the approved Soberanía runtime integration. It is recorded in
`protocol-consumer.lock.json` → `internalDependencySubpaths`, constrained to
`INTERNAL_DEPENDENCY_PROTOCOL_SUBPATHS`, and kept out of `verifiedPublicExports` and
`ALLOWED_PROTOCOL_SUBPATHS`. Frontera source still may not import it: the consumption gate, run on
fixtures by `tests/protocol-active-pin.test.mjs`, rejects such an import under `src/enterprise`,
`src/integrations` and `packages/*`. No Soberanía runtime package is introduced by this increment.

## Validation

Final results, all on the committed tree, run sequentially (no concurrent job):

| Check | Result |
| --- | --- |
| Isolated tarball validation (`validate-enterprise-against-protocol-tarball.mjs`, the CI `protocol-tarball-consumption` battery) | **every step passes**, including its embedded full test run: install, no sibling path, installed identity, all 15 subpaths resolve, typecheck, build, lint, test, consumption, AOC boundaries, publishability, release integrity, forbidden-import scan, declaration path-leak scan |
| `npm run typecheck`, `build`, `lint` | pass |
| `npm test` (root) | 13,397 tests, 0 failed (11 skipped, 7 todo — pre-existing); every workspace suite passes |
| `legal:check`, `check:release-coherence` | pass |
| `validate:publishability`, `check:clean-room-consumer` | pass |
| `check:protocol-compatibility-lock`, `verify-tarball-against-lock` (built artifact) | pass |
| `check:protocol-consumption`, `check:protocol-contract-adoption`, `check:aoc-boundaries`, `check:release-integrity`, canonicalization regression probe | pass |
| `qualify:pilot` | 181 passed, 0 failed; readiness PR-01…PR-20 |
| DEMO-01 evidence capture test | 4 passed |

### Artifact identity in both install forms

`tests/protocol-active-pin.test.mjs` applies one rule wherever it runs: the tarball the `@aoc/protocol`
devDependency installs must exist and match every pinned field (file name, size, SHA-256, SHA-512, npm
integrity). A relative spec must be exactly `file:./vendor/<pinned file name>`, so in the repository
the vendored tarball is mandatory; an absolute spec (the isolated validator's form, in a copy that
contains no `*.tgz`) is accepted only on the same full match. Nothing is skipped in either
environment. Verified by mutation:

| Environment | Mutation | Result |
| --- | --- | --- |
| repository | vendored tarball deleted | fails (2 tests) |
| repository | one byte of the vendored tarball flipped | fails (3 tests) |
| repository | devDependency pointed at the rc.1 tarball | fails |
| repository | `/canonical` added to the source allowlist | fails (2 tests) |
| repository | lock SHA-256 altered; a second internal subpath added | fails |
| isolated validator copy (absolute spec, regenerated lockfile, no `*.tgz`) | none | 44 tests pass, 0 skipped |
| isolated validator copy | external tarball corrupted / missing | fails (2 tests each) |
| isolated validator copy | spec rewritten to a relative, non-vendored path | fails (3 tests) |

### Earlier isolated runs, and why they failed

- Unmodified tree against rc.3 (procedure step 2): 2 of 13,383 failed. One is the expected lock
  mismatch (installed `0.2.0-rc.3` against the unmodified lock's `0.2.0-rc.1`); the validator keeps
  only the last 3,000 characters of a failing step, so the second was not named.
- A later run on an intermediate tree failed 3 tests: the first version of the new identity tests
  compared path text and read `vendor/*.tgz`, which the validator rewrites and excludes. Fixed by the
  identity rule above.
- A manual reproduction of the validator's copy with full output failed 2 tests, both payment
  timeouts unrelated to Protocol: PAY-07 `COEX-16` (`not-completed` after 3,003 ms) and PAY-08
  `BOP-X2…X10` (`AUTHORITY_FRESHNESS_UNAVAILABLE`, witness did not answer within 2,000 ms). Neither
  file imports `@aoc/protocol`; both passed 38/38 three times in that same copy, and pass in every
  in-place run. This is the pre-existing timing sensitivity already recorded in
  `docs/security/PROD-03-PILOT-ONBOARDING-OPERATIONAL-QUALIFICATION.md` for PAY-08 under the
  validator's lockfile-free install and parallel load. It is recorded here, not fixed: payment code is
  out of scope for this increment.

## What was preserved

- `vendor/aoc-protocol-0.2.0-rc.1.tgz`, `-rc.0.tgz` and `-0.1.0.tgz` and their evidence documents are
  byte-identical. The lock's `supersedes` chain records rc.1 as superseded and keeps the burned rc.0
  and 0.1.0 entries unchanged beneath it.
- `enterprise-integration.lock.json` and `release/frontera-candidate-manifest-1.2.1.json` are frozen
  handoff records of the 1.2.1 candidate and are not advanced here; doing so is a separate candidate
  cut.
- No Kernel, Host authorization, payment execution or production configuration change. Frontera ships
  no Protocol code, so no compiled output changes.
