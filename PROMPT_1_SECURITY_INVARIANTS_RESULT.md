Pushed. `node_modules/` is already gitignored, so the tree is clean.

---

## SUMMARY

Formalized the repository's existing security guarantees into one canonical, scope-carrying artifact, and corrected five places where a local guarantee was stated (including by my own Prompt 0 output) as if it were broader.

The core problem this closes: Frontera's guarantees are genuinely strong **inside specific paths** and absent outside them. Nothing previously forced a reader — human or AI — to carry the scope along with the claim. Every invariant now carries its scope as part of the invariant, and a test fails if a new one is added without one.

I also found and corrected a real discrepancy in my Prompt 0 report: it classified `src/kernel/**` as structurally capability-restricted. It was not. The tests cited were import-direction and pure-data-package tests; the Kernel had no capability ban at all. The property was true in fact (verified: zero fs/net/process/fetch occurrences) but nothing defended it. That is now enforced.

## CANONICAL INVARIANTS ADDED

`docs/security/SECURITY_INVARIANTS.md` — 34 enforced (SEC-INV-001…034), 7 trust boundaries, 8 unimplemented. Selected:

**Decision & composition** — 001 single decision producer (pipeline-scoped) · 002 narrowing-only · 003 recognition precedes allow · 004 reason codes always present · 005 request never mutated · 006 unconfigured port ⇒ byte-identical · 007 evaluate() issues nothing

**Effect paths** — 008 evaluation produces no external effect · **009** enforce() invokes executor only on allow · **010 LIMIT: enforce() does not bind the executor's effect to the declared action** · **011 no adapter call without usable bounded-grant exercise (PATH-LOCAL)** · 012 grant is read, never received · 013 immediate revocation/expiry visibility · 014 no free-form payload across the adapter boundary · 015 fail-closed bound comparison · 016 synchronous commit guard · 017 binding equality at commit · 018 attenuation-only · **019 BOUNDARY: Sovereign Access is a separate authority-bearing path**

**Capability/layer** — 020 no I/O (four modules) · 021 no dynamic code (+Kernel) · 022 no ambient clock/randomness · 023 no background-job dependency · 024 no AI in the authorization path · 025 no customer transaction key custody · 026 no external token format

**Surface/state** — 027 no caller-facing grant surface · 028 credentials off the public composition surface · 029 no public update/delete (two interfaces) · 030 redaction before digesting · 031 fail-closed digest check on read · 032 provisioning needs system + operator · 033 disjoint reason-code vocabularies · 034 assurance registry frozen

**Trust boundaries** — SEC-TRUST-001…007: host trust, privileged-writer limit, state durability, voluntary-chokepoint limit, process-isolation absence, adapter trust, deployment trust.

## LOCAL VS SYSTEM-WIDE CORRECTIONS

| Claim | Was stated as | Now scoped to | Verified by |
|---|---|---|---|
| Kernel is the only decision producer | System-wide | `src/` authorization pipeline — `agent-governance`'s `evaluateAgentRuntimeGuard` and Sovereign Access's `assertActive` named as separate producers | Kernel never imports the runtime guard |
| No AI in the authorization path | Layers B–E (Prompt 0 I-14) | **Documented** system-wide by ADR; **test-enforced** in 4 modules only — layers B, C, D carry no AI-ban test | Only 3 test files asserted it; Kernel now added as the 4th |
| Kernel structurally capability-restricted | "Yes" in Prompt 0's matrix | Was **unenforced**; now enforced | `structural-boundaries.test.ts:56,97` are import/pure-data tests, not capability bans |
| Stores expose no update/delete | Implied broadly | Exactly two interfaces; other stores `UPDATE` status/counters and re-seal digests | `structural-boundaries.test.ts:169,238` |
| No I/O in production layers | Broad reading | Four layer modules; `action-enforcement`, rest of `src/enterprise`, `packages/`, `apps/` uncovered | Four boundary test files |

Existing repository prose was **already correctly scoped** — `AOC_AUTHORITY_CONTROLLED_EXECUTION.md` §1 says "through the grant-aware path", and `grant-execution-service.ts:15` says "through this service". No document needed narrowing; the risk was in summarization, which §9 change-control now governs.

## EXISTING TESTS STRENGTHENED

New file `src/enterprise/__tests__/security-invariants.test.ts`, 17 assertions:
1. **Kernel capability ban** — no fs/http/net/child_process/fetch/sqlite (backs SEC-INV-020)
2. **Kernel dynamic-code ban** — no eval/Function/dynamic import/vm (SEC-INV-021)
3. **Kernel intelligence ban** — backs the ADR's layer-G rule at the decision producer (SEC-INV-024)
4. **Single adapter invocation site**, ordered after the usable-assessment gate, with the store re-read present — the existing `execution-exercise.test.ts` counts invocations through one service and would still pass if a second, ungated call site were added
5. **Scope schema check** — every `SEC-INV-nnn` row must declare one of the six tokens; SEC-INV-011 must stay PATH-LOCAL and keep naming its path

No existing test was modified. The comment-stripper technique is borrowed from the existing boundary tests so doc comments can still explain what does *not* happen.

## ASPIRATIONAL INVARIANTS RECORDED

| ID | Property | State | Owner |
|---|---|---|---|
| U01 | Signature from a key the process cannot read | Unimplemented | Prompt 5 |
| U02 | No signing key in process memory | Unimplemented | Prompt 6 |
| U03 | Egress only via allowlisted adapter | Unimplemented | Prompt 11 |
| U04 | Agent process holds no secret or authority-write capability | Unimplemented — dominates U03/sandbox | Prompt 7 |
| U05 | Single durable kill switch | **Partial** — exists, process-local, invisible to the exercise path | Prompt 12 |
| U06 | Aggregate behaviour bounded | Unimplemented; must be built *outside* layers B–E | Prompt 13 |
| U07 | Value-pattern secret redaction | **Partial** — key-name only | Prompt 15 |
| U08 | Capability-ban test per layer | **Partial** — 5 modules now (Kernel added) | Prompt 10 |

## PRODUCTION BEHAVIOR CHANGED?

**NO** — proven mechanically, not asserted. The only `src/` production change is a doc comment on `AocKernel.enforce()`. I built both revisions and compared emitted output:

```
PROVEN: emitted AocKernel.js is IDENTICAL once comments are stripped — zero executable change
--- lines compared: 360 ---
```

The source diff filter for non-comment added lines returned empty.

## FILES CHANGED

```
docs/security/SECURITY_INVARIANTS.md              +257  (new, canonical)
src/enterprise/__tests__/security-invariants.test.ts +232  (new, 17 assertions)
src/kernel/AocKernel.ts                            +20  (doc comment only)
docs/kernel/AOC_KERNEL_INVARIANTS_V1.md             +6  (Kernel-scope pointer)
README.md                                           +1  (doc index row)
docs/security/THREAT_MODEL_V1.md                  +1/-1 (companion reference)
```

Commit `a8e1f0e`, pushed to `claude/frontera-security-audit-eajd3o`. No PR opened.

## TESTS

| Command | Result |
|---|---|
| `npm run typecheck` / `npm run build` | **exit 0**, clean |
| `npm run lint` | **pass** (node16 imports, architecture, public surface) |
| Named suites (kernel invariants, structural, security-invariants, 4× layer boundaries, execution-exercise, 2× authority-controlled execution) | **255/255 pass**, 51 suites |
| `npm run test:root` | **5437/5437 pass**, 972 suites, 33.8s |
| `npm run test:workspaces` | **1007/1007 pass** |

**Total: 6,444 tests, 0 failures.**

One process note worth recording, since it affects anyone reproducing this: the container had **no `node_modules`**. `npx tsc` silently fell back to an ambient TypeScript 6.0.2 and emitted 34 `TS5101 baseUrl deprecated` errors, and two suites failed with `Cannot find module '@aoc-enterprise/governed-authority'`. Both were environment artifacts. After `npm install`, the workspace's pinned TypeScript 5.9.3 builds clean and everything passes. `package-lock.json` was not modified. I initially misread TS5101 as a pre-existing repo defect; it is not.

Unchanged from Prompt 0: Dependabot still reports 31 vulnerabilities on the default branch (4 critical, 12 high). Out of scope here, unaddressed, and worth its own pass before Prompt 22.

## PROMPT 2 READINESS

**Yes.** All ten success criteria are met: one canonical artifact; every invariant scoped; the scope schema is test-enforced; enforce()-vs-exercise is explicit in both the document and the Kernel's own doc comment; Sovereign Access is a numbered boundary invariant; existing properties preserved and two newly defended; containment gaps recorded as unimplemented with owners; no containment feature built; production behaviour proven unchanged; full suite green.

Prompt 2 (Map Trust Boundaries and Privileged Assets) inherits §6's seven trust assumptions as its starting scaffold. Two carry-overs from the Prompt 0 gap map still stand and are Prompt 2's to act on: `apps/agent-passport-web` remains outside every security artifact (SC-006), and the naming overclaims SC-013 (`verifyCapabilityToken` under `crypto`, verifies no signature) and SC-014 (`src/runtime/vault` performs no cryptography) are recorded but not yet addressed.

```
PROMPT 1 COMPLETE
PRODUCTION BEHAVIOR CHANGED: NO
READY FOR PROMPT 2: YES
```
