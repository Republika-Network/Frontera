# Frontera Systems — Official Test Strategy (v1.0.0)

This document defines the single sanctioned way tests are built and run in this repository, and the test-harness normalization shipped with v1.0.0 (PR-008 Part 5).

## The one command

```bash
npm test
```

which expands to:

```
npm run build
node --test "dist/src/**/*.test.js" "tests/**/*.test.mjs"
npm test --workspaces --if-present
```

Three layers, in order:

1. **Compiled root-tree tests.** All `src/**/*.test.ts(x)` compile with the production build (`tsc -b`) into `dist/src/**`, and `node --test` runs the **compiled JavaScript only**. Tests execute exactly the artifacts that ship.
2. **Repo-level contract tests.** `tests/*.test.mjs` — plain ESM contract/integration suites (protocol compatibility, runtime host contract, persistence/vault/federation/operational-state checks) that run without compilation.
3. **Workspace suites.** Every workspace with a `test` script runs it (`--if-present`). The workspace convention is: `tsc -p tsconfig.test.json` (emitting to a gitignored `dist-test/`) followed by `node --test 'dist-test/__tests__/**/*.test.js'`, executed from the workspace directory (several suites resolve fixtures relative to `process.cwd()`).

Supporting scripts: `npm run test:root` (layers 1–2 without rebuilding workspaces) and `npm run test:workspaces`.

## What was broken, and the fix

Before v1.0.0 the root script was a bare `node --test`, which recursively discovered **source `.ts` test files** across the repo. Node 22 runs `.ts` files via type stripping but cannot resolve their compiled-style `./module.js` import specifiers from source trees, so 413 test files failed structurally on `ERR_MODULE_NOT_FOUND` — noise that had nothing to do with the code under test, while the same tests passed as compiled artifacts in `dist/`. One additional suite (`pmfreak-structural-mirrors`) failed only because bare discovery ran it from the repo root instead of its workspace (its file scan is `cwd`-relative by design).

The fix is **explicit discovery**: the root run is scoped to compiled output plus `tests/*.test.mjs`, and workspace suites run through their own scripts with the correct working directory. No test was deleted, skipped, or weakened; the previously-failing files are the same tests that now run compiled — and pass.

Current state: **0 failing tests** — ~3,300 root-tree tests, 6 repo-level contract suites, and 4 workspace suites (agent-governance 78, pmfreak-agent-passport-foundation 82, agent-passport-web 268, enterprise-host-sdk 6).

## Rules

- **Never** rely on `node --test` bare discovery at the repo root; always go through `npm test` / `test:root`.
- New tests in the root tree: put them in `__tests__/` (or `tests/` for features) next to the code as `.test.ts`/`.test.tsx`; they are compiled and picked up automatically — nothing to register.
- New workspace tests: follow the `tsconfig.test.json` → `dist-test/` convention and add the standard `test` script; the root run picks the workspace up via `--if-present`.
- Tests must not depend on wall-clock time, randomness, or network (repo determinism rules); clocks and id generators are injected fixtures.
- Do not add test frameworks. The runner is `node:test` + `node:assert/strict`, matching the no-heavy-dependencies constraint.

## Known parked tests (explicit, not accidental)

`packages/governance-treaties/__tests__/governance-treaties.test.skip.ts` and `packages/runtime-negotiation/__tests__/runtime-negotiation.test.skip.ts` are deliberately named `.test.skip.ts` so no discovery pattern matches them; both packages are stub workspaces (bare `{"type":"module"}` manifests) without build wiring. Reactivating them (manifest, tsconfig, test script) is tracked as post-v1 work — they are the only test files in the repository that do not run.
