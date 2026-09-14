## SUMMARY

Redone properly on `claude/frontera-trust-boundaries` (created from latest `main` `c1d24e2`, Prompt 0/1 confirmed present, tree clean). Commit `851862d`, pushed. No PR opened, not merged — per your instruction.

Lesson taken: I assumed Prompt 2's scope rather than asking. Three things that cost: wrong branch name, wrong document path, and I'd used `TB-` for boundaries when your spec reserves it for findings.

## TRUST DOMAINS IDENTIFIED

22 (D-01…D-22). The load-bearing one is **D-22, marked CONCEPTUAL**: there is no agent execution runtime. `enforceAgentRuntimeGuard` returns booleans and withholds nothing; its only non-demo callers are proof pages. Every containment question in later prompts reduces to that.

## APPLICATION TCB
Kernel · action-enforcement + recognition/approval/handshake/policy-pack runtimes · grant + execution runtimes · composition root · Enterprise stores · ExecutionAdapter implementations · PolicyPackRegistry · the host process itself.

## DEPLOYMENT TCB
Host OS/kernel · process user and filesystem permissions · the env/secret file · TLS and reverse proxy · ingress restriction · data volume · backup storage · **time source** (expiry resolves to the host clock).

## EXTERNAL TRUST DEPENDENCIES
Stripe (webhook authenticity only) · Pinata · `better-sqlite3` · `@aoc/protocol` (commit+checksum pinned) · GitHub Actions · npm registry. **Cloud infrastructure is not assumed hardened** — `infrastructure/` is `.gitkeep` only.

## PRIVILEGED ASSETS
26 (A-01…A-26), each with holder/writer/reader/impact. `AOC_ISSUER_PUBLIC_KEY_PEM` called out separately: stored as an issuer public key under `hmac-sha256`, so it's a trust-anchor-shaped field with no trust-anchor function.

## AUTHORITY WRITERS

**The correction this forced:** it's accurate that *grant* write surfaces aren't caller-exposed, but that does **not** generalize. **Passport lifecycle** (issue/activate/suspend/reactivate/revoke/retire, `node-http-adapter.ts:377-402`) and **assurance** writes **are** HTTP-reachable, authenticated and tenant-scoped. Append-only and attributable is the mitigation — not inaccessibility. Your Step 4 warning about not generalizing from one store caught a real error I'd otherwise have shipped.

## EFFECT-CAPABLE PATHS
A evaluate (AUTHORITY-GATED) · B `enforce()` closure (PARTIALLY) · C bounded-grant (AUTHORITY-GATED) · D Sovereign Access (PARTIALLY, separate model) · E web routes (APP-LEVEL AUTHENTICATED) · F Stripe · G filesystem/backup/non-production. **No shell, child process, `eval`, `new Function` or dynamic `import()` in production TypeScript anywhere.**

## SECRET FLOWS
Every production secret is **PROCESS-RESIDENT** and **LONG-LIVED**, rotated only by restart. None is EXTERNALLY HELD or EPHEMERAL. **No KMS or HSM exists anywhere.**

## AGENT PASSPORT WEB SURFACE
31 routes classified by auth. Public-by-design: passport GET/verify, checkout. Inventory only — the dedicated audit is next.

## SECURITY CHOKEPOINTS
HARD: store-layer tenant scoping, Kernel decision boundary, bounded-grant gate (path-local), issuance commit guard, Stripe webhook signature. VOLUNTARY: adapter port, Sovereign `assertActive`, signer boundary, web per-route auth. DEPLOYMENT: HTTP auth (off by default), network boundary. FUTURE: egress, isolation, durable kill switch.

## BYPASS PRIMITIVES
13 enumerated. Two **absent**: shell/dynamic code, and customer transaction key theft (no such key exists).

## SC-013 RESOLUTION
**Two different `verifyCapabilityToken` functions.** The `crypto`-namespaced one validates shape/expiry/revocation-list membership, verifies no signature (the protocol carries no signature bytes), has an intentionally unused `trustDomain`, and **has no production caller**. A same-named function in `recognition-runtime` takes an *id* and **is** on the authorization path.

**Remedy: documentation + structural test. No rename** — it's exported from `src/index.ts`, whose `dist` artifact is SHA-256-pinned in `release/RELEASE_MANIFEST.json`. Renaming is consumer-breaking for zero behavioural gain. Also found TB-006: `verifyDelegatedCapability` is a pure alias performing no delegation check.

## SC-014 RESOLUTION
`src/runtime/vault` holds no key, encrypts nothing, calls no KMS, signs nothing. It's a **drift detector and continuity validator**. `createRuntimeVaultAttestation` is `parts.join(':')` — **not even a digest**, weaker than Prompt 0 recorded. Same remedy, same reasoning.

## NEW FINDINGS
TB-001 (HIGH) registry admin token permanent + in URLs · TB-002 (MED) bypasses RBAC · TB-003 (MED) SC-013 · TB-004 (MED) SC-014 · TB-005 (LOW) unvalidated `importVaultBoundary` · TB-006 (LOW) alias · TB-007 (LOW) no CI `permissions:` (mitigated: CI uses **no secrets**) · TB-008 (MED) web store has no integrity discipline. Five items assessed and explicitly **not** findings.

## FILES CHANGED
```
docs/security/TRUST_BOUNDARIES_AND_PRIVILEGED_ASSETS.md  +580 (new)
src/runtime/__tests__/naming-boundaries.test.ts          +175 (new, 8 assertions)
src/runtime/crypto/verification/capability-verifier.ts    +30 (comment)
src/runtime/vault/index.ts                                +25 (comment)
src/runtime/crypto/index.ts                                +7 (comment)
README.md / SECURITY_INVARIANTS.md / THREAT_MODEL_V1.md    +5/-2
```

## TESTS

| Gate | Result |
|---|---|
| typecheck / build | exit 0 |
| lint (3 checks) | pass |
| `check:release-integrity` | pass |
| `check:runtime-vault` | pass |
| `check:aoc-boundaries` | pass |
| `check:protocol-consumption` | pass |
| `test:root` | **5,445 / 5,445** |
| `test:workspaces` | **1,007 / 1,007** |

**6,452 tests, 0 failures.** Two things I hit and am not hiding:

1. First root run showed **9 failures** — 2 were stale `dist/` artifacts from the branch I abandoned (incremental `tsc -b` across a branch switch). `npm run clean` cleared them.
2. The 9th was **real and mine**: `check:protocol-consumption` failed because my vault comment said *"tenant/workspace/runtime drift detection"*, and `/workspace/` matched the guard's leaked-absolute-path heuristic, which is emitted into `dist`. I reworded the prose — I did not weaken the guard. The guard was right.

## PRODUCTION BEHAVIOR CHANGED?

**NO** — proven, not asserted. Every added `src/` line is a comment, and I built both revisions and compared emitted output:

```
IDENTICAL (comments stripped): dist/src/runtime/crypto/index.js
IDENTICAL (comments stripped): dist/src/runtime/crypto/verification/capability-verifier.js
IDENTICAL (comments stripped): dist/src/runtime/vault/index.js
```

Naming-boundary tests verified non-vacuous by injecting `node:crypto` into the vault — the suite failed, then passed on restore.

## PROMPT 3 INPUTS
§17 enumerates all seven effect paths with prove-or-except disposition, eleven authority-bearing paths, six alternate paths defeating a naive single-gate claim, four voluntary chokepoints, and eight bypass primitives.

## DEDICATED AGENT-PASSPORT THREAT MODEL READINESS
**Ready.** §10 gives the complete surface: 31 routes with auth classification, privileged operations, trust placed in each mechanism, persistence and tenancy model, plus TB-001/002/008 as starting threads.

**One housekeeping item:** my abandoned branch `claude/frontera-security-prompt-2-trust-boundaries` is still pushed with a superseded commit. Say the word and I'll delete it.

```
PROMPT 2 COMPLETE
PRODUCTION BEHAVIOR CHANGED: NO
AGENT PASSPORT THREAT MODEL READY: YES
READY FOR PROMPT 3: NO — DEDICATED AGENT PASSPORT AUDIT REQUIRED FIRST
```
