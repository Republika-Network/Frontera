# Repository Baselines (RN-CONFORM-01)

Recorded 2026-11-02. All repositories were read-only for this mission except this dossier, which
was written on a fresh branch of Frontera created from `origin/main`. No dirty worktree was modified.
Windows-created worktrees were read with `git.exe` because WSL Git cannot resolve their metadata.

## Confirmed repositories

| Repository | Local path | Branch (local) | Audited commit | Working tree | Notes |
|---|---|---|---|---|---|
| `Republika-Network/Frontera` | `C:\Users\Usuario\source\Republika-Network\Frontera` | `main` @ `dc4de111` (#205) | **`64b3ec7c`** = `origin/main` (#260) | Clean | Local `main` is ~55 commits behind origin. Audit and dossier use a clean worktree at `C:\Users\Usuario\Republika-worktrees\CONFORM\frontera` from `origin/main`. |
| `Republika-Network/Soberania_Protocol` | `C:\Users\Usuario\source\Republika-Network\Soberania_Protocol` | `refactor/sovereign-sphere-homepage` @ `96d6fca6` | **`590e4cb`** = `origin/main` (#398) | **Dirty (34 entries)** — untouched | Read only via `git show/grep origin/main`. |
| `Republika-Network/xrpl-sovereign-access` | `C:\Users\Usuario\source\Republika-Network\xrpl-sovereign-access` | `main` | **`3f7652f`** (#15) | Clean | Untracked, git-ignored `deploy/*.env` exist locally and were **not opened**. |
| `Republika-Network/live-data-rail` | `C:\Users\Usuario\source\Republika-Network\live-data-rail` | `main` | **`79a42be`** (#21) | Clean | |
| `Republika-Network/republika-network-web` | `C:\Users\Usuario\source\Republika-Network\republika-network-web` | `feat/rep-web-02-visual-refactor` @ `e1762fbf` | not audited | Clean | Marketing site; out of scope. |

### Additional worktrees (inspected, not modified)

| Worktree | Repository | Branch | Commit | State |
|---|---|---|---|---|
| `Republika-worktrees\ASSURE\frontera` | Frontera | `docs/assure-gov-02-independent-review-handoff` | `988d1465` | Clean |
| `Republika-worktrees\ASSURE\soberania` | Soberania_Protocol | `feat/assure-01-discovery` | `e85cf1bb` | Clean |
| `Republika-worktrees\FV\frontera` | Frontera | `feat/fv-p4c2b3c2a-identity-registration` | `64b3ec7c` | **Dirty (16 entries)** — untouched; in-progress FV identity registration work not reflected in this dossier |
| `Republika-worktrees\FV\soberania` | Soberania_Protocol | `docs/fv-p4b-sovereign-status-profile` | `fcc6c04b` | Clean |

## Not found / UNKNOWN

| Named in mission | Finding |
|---|---|
| "Sovereign Access SDK" | **No package by this name** in any repository. The closest SDK-shaped packages are Protocol `@aoc/aoc-sdk` (PARTIAL remote-runtime client), Frontera `@aoc-enterprise/enterprise-host-sdk` v1.1.0 (Host HTTP client) and `xrpl-sovereign-access` (an XRPL projection vertical, not an SDK). Treated as UNKNOWN product boundary → [CC-D-10](DECISION_REGISTER.md#cc-d-10). |
| Republika Network infrastructure repository | No dedicated infra repository found locally. UNKNOWN. |
| Existing validator / attestation network repository | None. See [EXISTING_CAPABILITIES.md §B3](EXISTING_CAPABILITIES.md#b3-validator-infrastructure). |

## GOV-02 baseline check

* `c19a563d` — *docs(assurance): independent reviewer engagement and evidence handoff (ASSURE-GOV-02) (#257)* is an ancestor of `origin/main`.
* Commits after #257 on `origin/main`:
  * `4323d5d1` CORE-07-FV-WITNESS: Independent Identity Freshness Domains (#258)
  * `d215b701` FV-EXEC-LOCK-01: Harden Linux SQLite Lock Ownership Verification (#259)
  * `64b3ec7c` CI-TEST-LOG-01: Preserve Protocol Tarball Test Failure Diagnostics (#260)
* None of them touches `src/enterprise/assurance/**`.

## Protocol pin observation

`protocol-consumer.lock.json` pins `@aoc/protocol` 0.2.0-rc.3 at commit `fd705f689e04…`
(*chore(release): prepare security RC candidate 0.2.0-rc.3 (SOBE-SEC-01T)*). That commit exists on
GitHub but is **not on Protocol `origin/main`** (GitHub compare: diverged, 8 ahead / 4 behind) and is
absent from the local clone. `enterprise-integration.lock.json` still records rc.1 at `eec79cdd…`.
This does not block design work, but any conformance profile that pins "SDK version" must define which
lock is authoritative → [CC-D-11](DECISION_REGISTER.md#cc-d-11).

## Frozen-artifact baselines (verified unchanged)

| Artifact | Location | Value |
|---|---|---|
| `rn.sv@0.1.0` golden digest | `src/enterprise/__tests__/assurance-rn-sv-framework.test.ts:30` | `sha256:e71fafe1a10af95514823e35d43138b1b93cdb72e37765200447a37748c13a58` |
| `rn.sv` framework source | `src/enterprise/assurance/frameworks/rn-sv-framework.ts` | git blob `42de61c1…`; last change `cfb0aa61` (#228) |
| `aoc.saf@1.0.0` golden digest | same test, line 31 | `sha256:4c0b5c65a0b8cfe40de726f26d80b80224fac6ca80fe2c221f7a734548899bb9` |
| Founding Assessment decision | `docs/commercial/founding-assessment/ASSURE_COMMERCIAL_GO_NO_GO.md:3` | **FINAL COMMERCIAL DECISION: NO-GO** |

## Relevant pull requests (by capability)

| Capability | Frontera PRs | Other repositories |
|---|---|---|
| Assurance engine & security | #227 (rn.sv), #228–#229, #232–#233, #235 (SEC-01A–E), #237 (REP-01), #238 (PILOT-01B), #240, #242, #244, #248 (REL-01A–D), #249 (REL-01E), #251, #253 (OPS-01/02), #254 (GOV-01), #256 (CLAIMS-01), #257 (GOV-02) | — |
| FV document use / status | #230, #231, #234, #236, #239, #241, #243, #245, #246, #247, #250, #252, #255, #258, #259 | Protocol #397 (document-use profile, synthetic fixtures), #398 (sovereign status profile) |
| Kernel / authority | #213 (AUTH-03), #217 (deny-only external authorization port), #221 (RSDK-01), #225 (RSDK-02 governed receiver) | Protocol #393 (issuer key binding, rc.3) |
| XRPL | — | xrpl-sovereign-access #12 (XRPL-11 claim gate), #14 (controlled Testnet preview), #15 (Frontera Testnet live qualification) |

## Key test suites referenced by reuse claims

| Area | Test paths (Frontera unless noted) |
|---|---|
| Assurance store contract | `src/enterprise/__tests__/assurance-store-contract.test.ts` |
| Assurance lifecycle / immutability | `assurance-lifecycle.test.ts`, `assure-ops-01-terminal-review.test.ts`, `assure-rel-01d-concurrency.test.ts` |
| Findings and atomic completion | `assurance-findings.test.ts`, `assurance-sec-01e-finding-event-integrity.test.ts` |
| Tenant isolation | `assurance-sec-01d-tenant-bundle-verification.test.ts` |
| Signals | `assurance-signals.test.ts` |
| Signed status + anti-replay | `packages/sovereign-receiver-verification/__tests__/sovereign-status.test.ts`, `document-freshness.test.ts` |
| Durable status history | `src/enterprise/__tests__/fv-p4c2a-sqlite-status-history.test.ts`, `tests/fv-p4c2a-sqlite-status-history.e2e.test.mjs` |
| Dual-human authorizer | `src/enterprise/__tests__/fv-p4c2b2-human-decision-authorizer.test.ts` |
| Witness challenge protocol | `src/enterprise/__tests__/authority-state-freshness-*.test.ts` |
| Kernel external authorization | `src/kernel/__tests__/kernel-external-authorization.test.ts` |
| XRPL write path / reconciler / quorum | xrpl-sovereign-access `tests/writer/*`, `tests/reconciler/*`, `tests/xrpl-adapter/*`, `tests/xrpl11/*` |
| Outbox | live-data-rail `tests/integration/durable-outbox-postgres.test.ts`, `outbox-claim-safety-postgres.test.ts`, `outbox-restart-postgres.test.ts` |
| XRPL quorum / source trust | xrpl-sovereign-access `tests/xrpl-adapter/quorum.test.ts`, `tests/reconciler/episodes.test.ts` |

No test suite was executed by RN-CONFORM-01; all statuses are from source and test reading.
