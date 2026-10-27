# Soberanía runtime dependency closure — qualification evidence (FRONTERA-SOBE-PILOT-01C0)

**Status: NOT PUBLISHED.** No registry publication, tag, release or deployment. This document records
what was verified; it authorizes nothing. No Frontera source consumes the runtime, the Kernel's external
authorization port is not configured, and the Host is not changed.

## Upstream source

| Field | Value |
| --- | --- |
| Repository | `Republika-Network/Soberania_Protocol` |
| Change | PR #396 (SOBE-TYPES-01), squash merge |
| Merge commit | `e85cf1bbb76e844fee7ff6ad5dd5389d26a5f180`, parent `1112c63d93875400aeae8e01d85f3c8543be51d4` |
| Tree | `526df04132d0cb0b5dac293c298eae1a104223db` — identical to the qualified PR head `74f901c25a4c867219994d79752fc6d899b02309` |
| Review | **No approving review.** Merged by the founder through an organization-admin ruleset bypass (rule suite 4751310931, result `bypass`). |
| Post-merge checks on `e85cf1b` | CI, Release Validation, Publishability, RC Validation, Changeset Validation and CodeQL: success |
| Protected tag | `source/aoc-protocol-0.2.0-rc.3` unchanged (→ `fd705f68…`) |

## Reproducible repack

Two independent fresh clones at `e85cf1b`, each `npm ci` and `npm run build` (no tracked file changed:
the build reproduces the committed `dist/`), then `npm pack` of all seven packages. Node v22.23.1,
npm 10.9.8.

| Package | Reproduction A = B | Compared with the 01A pin | SHA-256 |
| --- | --- | --- | --- |
| `@aoc-runtime/authorization-runtime` | identical | **changed** (declarations only) | `cf8ebb7f07d49da4ae3630d88ed99bbe98d4bf6a876fc0653d101436e4fb6e51` |
| `@aoc-runtime/capability-runtime` | identical | identical | `c4b3a7ee9fb5bdebf37e5f7ad26915c5fbb8e2aff8f17eb5f5995c4c2942e4b5` |
| `@aoc-runtime/consent-runtime` | identical | identical | `16291bc15a7d21e384bba5a857fc160b94454dac6245aee3bf402606df6aaccc` |
| `@aoc-runtime/crypto` | identical | identical | `8fc44bee0e80cbd6afeaf07149e0decbad1212ba234c6383a30663e937df3f3a` |
| `@aoc-runtime/governance-runtime` | identical | identical | `90397c96326b5b5c663e31d4fa622a99b6ec50162e129763354fa31dc922672b` |
| `@aoc-runtime/provider-interfaces` | identical | identical | `48aebc4adda787adaf55828ffd7e5daf8e225d1e9b8e67f24e344ec9a1e0c4f5` |
| `@aoc-runtime/shared-types` | identical | identical | `587b900de77470ea400099e7ed71d43e50c423832f9a0e6de959ac0ae2efe28f` |

`@aoc-runtime/authorization-runtime`: 13,903 bytes, 7 files (same inventory as before);
sha512 `0e09fb16…27e9a4`; integrity `sha512-Dgn7FtFfD+KhUvSjFcpxmBAPbyj05FdeEs13yV1vR8JoAQxmAuM3Hyv6maJ+HygkGhyaGM5rSdEyYgOk7CfppA==`.
Its `dist/index.js` is byte-identical to the 01A artifact (sha256 `995adbbd…34bf`); its `dist/index.d.ts`
imports only `capability-runtime`, `consent-runtime`, `governance-runtime`, `crypto` (type-only) and
`shared-types` — the excluded package names appear only in documentation comments. The full SHA-512,
integrity and file inventory of every artifact are in `soberania-runtime-consumer.lock.json`.

The SOBE-TYPES-01 qualification tarball had the same SHA-256; the vendored artifact is the merged-source
reproduction above, not that file.

## Installation

| Surface | Change |
| --- | --- |
| `packages/soberania-runtime-closure/package.json` | new private, code-free workspace: the seven tarballs and `@aoc/protocol` (the root's artifact) as production dependencies |
| `package-lock.json` | +7 `node_modules/@aoc-runtime/*` entries (each `resolved` to its vendored tarball, `integrity` equal to the lock, production) and the workspace link; `node_modules/@aoc/protocol` loses `dev: true`; nothing else changes |
| Root `package.json` | dependencies, peer range and `bundleDependencies` unchanged; one script added |
| Published `@aoc-enterprise/runtime` | same 10,282-file inventory, every file byte-identical to main's pack except `package.json` (the added script); no new dependency or bundled package; publishability and the clean-room consumer pass with the consumer installing only the runtime and Protocol artifacts |

Why not the root package: declaring the closure there forces the published artifact either to bundle it
or to carry unresolvable `file:` specifiers, and moving `@aoc/protocol` into root `dependencies` turns the
external peer into a hard dependency. Both were tested: a consumer of such an artifact installs, but
`npm ls` reports the bundled packages and `@aoc/protocol` as invalid (`ELSPROBLEMS`). Keeping
`@aoc/protocol` a peer and overriding it locally is rejected by npm (`EOVERRIDE`). The decision of how the
published artifact eventually carries the runtime belongs to FRONTERA-SOBE-PILOT-01C1.

## Production install (`npm run qualify:soberania-runtime-closure`)

| Case | Result |
| --- | --- |
| P1 clean export | pass |
| P2 `npm ci --omit=dev --include-workspace-root --workspace=packages/*` (the Dockerfile command) | pass |
| P3 seven packages installed as real directories, every file byte-identical to the vendored artifact; `@aoc/protocol` 0.2.0-rc.3; no excluded package; no `typescript` | pass |
| P4 `vendor/`, `src/`, `tests/` deleted; the 01A scenario runs from the closure workspace with a clean environment; only `A allowed` allows; only the five executable runtimes and `@aoc/protocol/dist/canonical/` load | pass |
| Control: the same qualifier against unmodified main `cb90a75` | fails at P3 (runtime not installed); P4 then aborts because the closure workspace does not exist there |

## Strict TypeScript consumer

`tests/fixtures/soberania-runtime/strict-consumer`, compiled by `tests/soberania-runtime-consumption.test.mjs`
in a temporary directory that holds only the lock-verified artifacts and the installed `@aoc/protocol`
(no Soberanía checkout, no Frontera source, no `paths`): `strict`, `skipLibCheck: false`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `types: []`. TypeScript 5.9.3 (Frontera's).

- **Compiles** with exit 0; the source contains no `any`, type assertion, ambient module declaration or
  suppression comment, and the fixture has no `.d.ts` of its own.
- **Seven negative controls** fail on exactly their seven lines: a non-generic finalizer, a reshaping
  finalizer, a misnamed method, a synchronous verifier, an incomplete verification result, a missing
  finalizer argument and an empty finalizer object.
- **Decisions** (real `AuthorizationRuntime`, `GovernanceRuntime`, `CapabilityRuntime`, `ConsentRuntime`,
  grants signed by the real `crypto`): only the valid owner-signed delegated consent allows. Denied at
  consent: a grant signed with another trusted key, a missing delegate countersignature, no consent,
  expired consent, revoked consent, an empty trusted key set. Denied at capability: no capability, an
  expired capability, a malformed evaluation time. Denied at governance: no matching rule, a deny rule.
  A policy, capability or consent provider that throws makes `evaluate()` reject with the provider's
  error: never a decision, never an allow.
- **Loaded modules**: only the five executable runtimes and `@aoc/protocol`; no declaration package and
  nothing excluded.
- **Finalizer**: `NON_PRODUCTION_PASS_THROUGH_FINALIZER` is frozen, labelled *TEST FIXTURE ONLY — NOT A
  PRODUCTION AUDIT FINALIZER*, signs and records nothing, and lives only in the test fixture; the closure
  workspace ships no code.

Typing findings carried into 01C1: `AuthorizationInput` does not declare `now` although
`CapabilityRuntime` reads it (a caller that omits it evaluates capability expiry against the wall clock),
and `CapabilityRef` does not declare `expiresAt` although it is honoured. The fixture states both with
intersection types, without assertions.

## Integrity, policy and boundaries

- `check:soberania-runtime-lock`: lock policy and artifact bytes as in 01A, plus — only the closure
  workspace declares the runtime, with exactly the approved set and the root's Protocol artifact; no other
  manifest declares a runtime or excluded package; `package-lock.json` installs exactly the locked
  artifacts once, at the top level, as production packages, and nothing excluded anywhere. Each new rule
  is mutation-tested (20 negative cases).
- The in-repository `node_modules/@aoc-runtime/*` are real directories, byte-identical to the artifacts.
- npm refuses a substituted tarball under a recorded integrity (`npm ci`: `EINTEGRITY`).
- The Kernel's `externalAuthorization` option is referenced by no file outside the Kernel's own four
  files (searched: `src`, `packages`, `apps`, `scripts`, `deploy`); with it absent the Kernel is
  byte-identical to before 01B (01B suite, run by `npm test`).
- `@aoc/protocol/canonical` remains an internal dependency only; no Frontera source imports the runtime.

## Base and reconciliation

| Field | Value |
| --- | --- |
| First qualification | commit `2638a42` on main `9f3b44f` |
| Reconciled | rebased onto `cb90a75` (AUTH-04D1, #219), then onto `8f5472e` (AUTH-04D1R, #220) |
| Conflicts | `CHANGELOG.md` only, positional: both entries kept verbatim, this one first; nothing else overlaps |
| Patch | identical across the rebases except `CHANGELOG.md` placement and blob index lines |
| AUTH-04D1 / AUTH-04D1R | they change no lockfile, Dockerfile, `vendor/`, Soberanía or Protocol tooling, Kernel or release manifest file; their `package.json` script additions and this one coexist |

## Validation

### Structural gates on the tree rebased onto `cb90a75` (sequential, after a fresh `npm ci`)

| Gate | Result |
| --- | --- |
| `npm ci`, `typecheck`, `build`, `lint`, `legal:check` | pass (`legal:check:strict` fails identically on main: unrecorded licenses of `busboy`, `streamsearch`) |
| `check:soberania-runtime-lock`, `check:protocol-consumption`, `check:protocol-contract-adoption`, `check:protocol-compatibility-lock`, `check:protocol-canonicalization`, `validate:invalid-imports`, `check:aoc-boundaries` | pass |
| `check:host-configuration`, `check:runtime-state`, `check:runtime-persistence`, `check:runtime-federation`, `check:runtime-vault`, `check:portability-smoke` | pass |
| `check:release-integrity`, `check:release-coherence`, `validate:publishability`, `check:clean-room-consumer` | pass |
| Kernel external authorization suite | pass |
| `qualify:soberania-runtime-closure` (HEAD), `qualify:pilot` | pass |
| `protocol:tarball:verify-lock` (tarball built from `fd705f68`, sha256 `3d17beff…58f4`) | pass |

### Gates repeated after the rebase onto `8f5472e`

AUTH-04D1R changes `src/` (human-authority shutdown drain) but not `package-lock.json`, so the installed
tree was kept. `typecheck`, `build`, `lint`, `check:soberania-runtime-lock`, `check:protocol-consumption`,
`check:aoc-boundaries`, `check:release-integrity`, `check:release-coherence`, the 27 Soberanía consumption
tests, the Kernel external authorization suite (73), both AUTH-04D1R suites (10),
`qualify:soberania-runtime-closure`, `validate:publishability` and `check:clean-room-consumer`: pass.
The full suite and the isolated validator were not re-run on this tree.

### Full suite and isolated validator (base `cb90a75`): failing, on both trees

These mandatory gates **fail** on this branch and on clean main. They are recorded, not passed.

| Run | Branch | Clean main `cb90a75` |
| --- | --- | --- |
| `npm test` | 13,767 tests, **10 failing** top-level tests | 13,756 tests, **9 failing** top-level tests |
| Isolated Protocol tarball validator, `test` step (every other step passes on both) | **5 failing**, 43 cancelled (10 top-level tests) | **26 failing** (13 top-level tests) |

- Branch `npm test`: AUTH-01, CTRL-02, G-02C1D process, CORE-05, CORE-04 §62/§94, CORE-04 database
  writer, PAY-09 governed, TRADE-04C-S1 §7, TRADE-04D D-1 crash points, TRADE-04D H-1.
- Main `npm test`: AUTH-04B2, CTRL-01, G-02C1D on the shipped Host (2), PAY-08 (2), PAY-09
  coexistence, TRADE-04D D-1 migration, TRADE-04D Scenario H.
- Branch validator: AUTH-04B2, CORE-05, CORE-04 §92, six K1 suites (a `before` hook failed with
  `AUTHORITY_FRESHNESS_UNAVAILABLE`; their 43 tests were cancelled), R8-E/R8-F.
- Main validator: AUTH-04C (2), AUTH-04B, AUTH-04B2 (2), CORE-02, G-02C1C, CORE-05 (2), CORE-04,
  PAY-08, TRADE-04C C, TRADE-04D.
- `AUTHORITY_FRESHNESS_UNAVAILABLE` (*the authority-state witness did not answer within 2000 ms*)
  appears in all four runs (branch 5 and 8, main 3 and 5). The machine was shared with other workloads
  (load average 14–25 on 16 CPUs).
- PAY-03 (the first pass's undiagnosed failure) passed all 32 of its tests in all four runs. That does
  not diagnose the original failure.

### Targeted comparison of the failures not seen on main

The six test files behind the failures that appeared only on the branch (`auth01-connected-approval-execution`,
`trade04c-s1-host`, `trade04d-h1-post-intent-outcome`, `trade04d-d1-intent`, `trade04c-r8-trade-policy`,
`g02c1d-end-to-end-process`; 94 tests) were run three times on each tree on 2026-10-27 (times UTC−6), alternating branch and main,
never concurrently, with the same command (`node --test` on the compiled files, `NODE_OPTIONS` and
`NODE_PATH` cleared).

| Run | Start | Load (1 min) | Duration | Result |
| --- | --- | --- | --- | --- |
| branch 1 | 12:59:52 | 16.7 | 50.0 s | 94/94 pass |
| main 1 | 13:00:42 | 20.1 | 42.9 s | 94/94 pass |
| branch 2 | 13:01:25 | 21.6 | 45.2 s | **2 fail**: G-02C1D *a capability that expires before it arrives* (expected `failed`, got `completed`); TRADE-04D D-1 CORE-07 stale restore (`AUTHORITY_FRESHNESS_UNAVAILABLE`) |
| main 2 | 13:02:11 | 21.6 | 39.3 s | 94/94 pass |
| branch 3 | 13:02:50 | 23.6 | 38.7 s | 94/94 pass |
| main 3 | 13:03:29 | 24.7 | 46.0 s | **10 fail**: AUTH-01 (approval endpoint 503, then nine `GOVERNED_ACTION_APPROVAL_PENDING` follow-ons) |

The code these tests execute is identical on both trees: the compiled `dist/src` trees are byte-identical
(`diff -r` empty), and `node_modules` differs only by the added `@aoc-runtime/*` packages and the closure
workspace link, which no compiled file references.

Attribution:

- **AUTH-01**: also fails on clean main (main 3), with the same withheld-approval follow-ons —
  baseline instability.
- **TRADE-04C-S1 §7, TRADE-04D H-1, R8-E/R8-F** (`PROVIDER_REJECTED` from the separate signer process):
  3/3 pass on each tree; not reproduced. The TRADE-04C/04D family also fails on main in the full runs.
- **TRADE-04D D-1**: the crash-point failure did not recur (3/3 on each tree); a different D-1 test failed
  once on the branch with `AUTHORITY_FRESHNESS_UNAVAILABLE`, the timeout seen on main.
- **G-02C1D capability expiry**: failed on the branch twice (full run and targeted run 2), never on main
  (full run, validator, three targeted runs). The test sends a 1 s capability through a relay that
  delays it 2.5 s and expects the executor to refuse it; twice the run completed. Because the executed
  code is byte-identical, this change cannot cause it, but the cause is **not explained** and the
  assertion concerns capability expiry. It is recorded as an open baseline-code intermittent for
  separate investigation.

No reproducible regression attributable to this change was observed. The intermittent failures are
not fixed or shown to be unrelated by these runs.

## Unchanged

Kernel, Host, Host configuration, authentication, payments, evidence, deployment files (including the
Dockerfile), the frozen release manifest, the published artifact's contents other than its `package.json`
script list, `@aoc/protocol`'s pin and peer range, and every Frontera `src/` file.
