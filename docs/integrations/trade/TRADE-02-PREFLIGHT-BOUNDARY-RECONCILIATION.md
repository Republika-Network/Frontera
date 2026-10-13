# TRADE-02 Preflight — Architectural Boundary Reconciliation & Regression Gate

> **TRADE is an independent governed-action vertical**: not generic CORE, not
> a PAY rail, not a payment-protocol adapter. The structural tests now say so —
> by classifying it, never by excusing it from scanning.

- Status: preflight complete — test-only changes, no production code changed.
- Builds on: TRADE-01 (`b8ae3a0`, `docs/integrations/trade/TRADE-01-CANONICAL-OFFERCREATE-CONTRACTS.md` §10, §12).
- Branch: `feat/trade-02-xls75-delegation-verifier`, created from `b8ae3a0`.
- Architectural decision (approved): TRADE is a distinct vertical; the CORE, PAY and NO_BYPASS invariants are not weakened.
- Unchanged: all production sources, CORE, PAY-02 rail, PAY-03 signer protocol and interlocks, PAY-04 ingress, PAY-05, PAY-06, registries, configuration, `package-lock.json`, website.

---

## 1. The conflict, exactly

`pay04-payment-protocol-structure.test.ts` (M39) defined generic CORE as
*every* `src/features/*` module except `payment-runtime`, plus the Kernel,
runtimes, Host, control plane, non-edge enterprise modules and packages. One of
its assertions pins the **exact** list of CORE files whose text matches
`/xrpl/i` (PAY-03's Host composition and P9's documentation — 7 files).

`src/features/trade-runtime` therefore counted as CORE. Any TRADE file naming
its venue by the four-letter token — which TRADE-02's delegation verifier must
(`Delegate` ledger entry, XLS-75 vocabulary, network ids) — would change that
exact list and fail the test, although no CORE file had changed. TRADE-01
worked around it with a placeholder rule in its own boundary test (spell the
venue "XRP Ledger"), deferred to review.

A probe run confirmed the scope: a temporary TRADE file containing read-only
XRPL delegation vocabulary failed exactly two of the 50 structural suites —
the PAY-04 exact list and the TRADE-01 placeholder — and nothing else.

## 2. The reclassification

### 2.1 `pay04-payment-protocol-structure.test.ts`

| Change | Effect |
| --- | --- |
| `VERTICALS = {payment-runtime, trade-runtime}`; CORE excludes both | TRADE is no longer CORE. Every other CORE root and filter is identical. |
| New `TRADE` scan set | TRADE is scanned as itself, not dropped. |
| New test: *the scan sets partition the feature modules* | Exactly two verticals; every other feature module is entirely in CORE; no TRADE file is in CORE. A new feature module is CORE by default (proved by fixture J, §4). |
| New test: *the trade vertical is scanned on its own* | The full M39 payment-protocol vocabulary (MPP, x402, bolt11, …) is refused in TRADE, code and prose. |
| `nothing outside the edge composes the ingress` scans `CORE + TRADE + scripts + apps` | Removing TRADE from CORE does not remove it from this NO_BYPASS check. |

Unchanged: the CORE protocol-vocabulary scan, the **exact 7-file XRPL list**,
the reserved-context-key test, and every ingress, freshness and NO_BYPASS test
in the file.

### 2.2 `trade-vertical-structure.test.ts` (new, `src/enterprise/__tests__/`)

Each scan is a pure predicate over `(path, text)` and is applied both to the
repository and to synthetic violations.

| # | Requirement | Assertion |
| --- | --- | --- |
| 1 | Generic CORE independent of TRADE | No production file in `src`, `packages`, `scripts`, `apps` outside TRADE mentions `trade-runtime`. Approved TRADE composition edges: **none** (pinned empty). |
| 2 | PAY independent of TRADE | `payment-runtime`, `xrpl-payment-rail`, `payment-protocol-ingress`, `payment-settlement` never mention `trade-runtime`. |
| — | TRADE independent of PAY | TRADE imports no payment vertical, rail, protocol adapter, signer, ingress or settlement. |
| 3 | No second governance engine | TRADE imports only itself, `execution-runtime` / `monetary-runtime` / `governed-parameter-runtime` barrels and `crypto`; no `evaluate(`, `decide(`, `PolicyPack`, grant issuance or exercise, orchestrator, `govern(`, `ExecutionAdapter`. |
| 4 | Cannot sign | No `sign(`, `multisign(`, `signTransaction`, signer protocol or transport. |
| 5 | Cannot submit | No `.submit(`, `submitAndWait`, `autofill(`, `command: 'submit'`, `new Client(`, `fetch`, WebSocket, `connect(`, Node network modules. |
| 6 | No seeds or keys | No `Wallet`, `fromSeed`/`fromSecret`/`fromMnemonic`/`fromEntropy`, `deriveKeypair`, key generation, `privateKey`/`seed`/`mnemonic`/`secret` bindings, `ripple-keypairs`, `secret-numbers`. |
| 7 | No new XRPL SDK importer | PAY-02's own SDK-import pattern, verbatim: zero TRADE files, production **or test**. PAY-02's repository-wide exact importer list and single submit request are untouched and still binding. |
| 8 | PAY-03 signer unchanged | Operation `sign-xrpl-payment`, paths `/v1/identity`, `/v1/sign/xrpl-payment`; a valid Payment parses (control) while the same transaction as `OfferCreate`, with a `Delegate` field, or reshaped with `TakerGets`/`TakerPays` is refused; the PAY-03 edge never names `OfferCreate` or TRADE. |
| 9 | PAY-04 ingress unchanged | Its sources name no `trade-runtime`, `trade`, `OfferCreate` or XRPL (its own M40 tests and expected source list are unchanged). |
| 10 | Tests still fail on violations | In-file negative fixtures for every scan, plus temporary real files (§4). |

Fixture samples that other repository-wide scanners would read as real sites
(`command: 'submit'`, SDK specifiers, network modules) are assembled at runtime,
following `no-bypass-effect-paths.test.ts`. A first draft wrote one literally and
PAY-02's submit-site scan correctly flagged it; that was fixed in the fixture,
not in the scan.

### 2.3 `trade-runtime-boundaries.test.ts` (TRADE-01)

The placeholder *"does not name the XRP Ledger by the four-letter token"* is
replaced by *"may name its venue, but never reaches the payment vertical's XRPL
rail, signer or client"* (no `payment-runtime`, `xrpl-payment-rail`,
`rails/xrpl`, `createXrplSdkClient`, `createXrplRlusdRail`,
`createExternalXrplSigner`, `sign-xrpl-payment`, `EXTERNAL_XRPL_SIGNER`). Every
other TRADE-01 boundary test — SDK, network, submission, custody, purity,
no-execution-path, import allowlist, nothing imports TRADE — is unchanged.

## 3. Why this preserves security

- **CORE is scanned exactly as before**, minus seven TRADE files that were never
  CORE. The exact XRPL list did not change. A violation planted in CORE still
  fails (fixtures A, B, J).
- **TRADE is not exempted from anything it was subject to.** It is still in
  PAY-02's repository-wide SDK and submit scans, the NO_BYPASS inventories,
  `payment-runtime-boundaries` (which treats every non-payment feature as core
  that must not import PAY), the PAY-04 ingress composition check, and the M39
  vocabulary scan (now as its own set). The only thing it gained is permission
  to *name* the venue.
- **The new tests are stricter for TRADE than before**: PAY-02's fuller SDK
  pattern (double quotes, `require`, dynamic `import`), TRADE test files
  included, two-way PAY independence, and a behavioural PAY-03 check.
- **No blanket exception** was added: no allowlist entry for TRADE in any SDK,
  submission, network or signer inventory.

## 4. Negative tests — temporary real files

Each fixture was written into the tree, the 51 structural suites were run, and
the fixture was removed (`git status` clean afterwards). Failing tests are those
attributable to the fixture. (In the first run, all scenarios also showed a
failure from PAY-02's submit-site scan, caused by the literal described in §2.2
and since fixed; E and K were re-run after the fix.)

| | Planted violation | Caught by |
| --- | --- | --- |
| A | CORE (`governed-parameter-runtime`) names XRPL and imports the SDK | PAY-04 exact XRPL list; PAY-02 SDK importers; CORE-08/governed-parameter neutrality and import boundaries (6) |
| B | Kernel names a payment protocol | PAY-04 M39 CORE vocabulary |
| C | Enterprise CORE re-exports TRADE | trade-vertical (1); TRADE-01 "nothing imports TRADE" |
| D | `payment-runtime` re-exports TRADE | trade-vertical (1), (2); TRADE-01; payment-runtime import boundary |
| E | TRADE imports the SDK and submits | trade-vertical (3), (4–6), (7); PAY-02 SDK importers; TRADE-01 import allowlist and no-SDK/no-submit |
| F | TRADE signs, holds a seed | trade-vertical (4–6); TRADE-01 custody |
| G | TRADE imports `payment-runtime` | trade-vertical TRADE→PAY and (3); TRADE-01 allowlist and venue/rail rule; payment-runtime "core must not import PAY" |
| H | TRADE names `x402` | PAY-04 new TRADE vocabulary scan |
| I | TRADE calls `govern(` | trade-vertical (3); TRADE-01 no-execution-path |
| J | New undeclared feature module names XRPL | PAY-04 exact XRPL list (a new module is CORE by default) |
| K | **Control**: TRADE names XRPL only | nothing fails — the one intended relaxation |

## 5. Timing failures (CORE-06 T7, SQLite write-lock wait)

### 5.1 Evidence

A 10-minute probe sampled `Date.now()` against `performance.now()` every 5 ms
on this WSL2 host (kernel `6.18.33.2-microsoft-standard-WSL2`), idle:

- 20 backward wall-clock steps — one every ~30 s, 9–28 ms each;
- wall clock drifted −488 ms against the monotonic clock over the run.

Under full-suite load the SQLite test measured a −1585 ms "wait" between two
wall-clock reads taken in program order, which is only possible if the wall
clock stepped backwards. The host's time sync corrects a slow wall clock in
steps; the steps are larger under load.

### 5.2 Mechanism

- **SQLite write-lock wait** (`exercise-control-sqlite.test.ts`): the test
  injects its own clock into the ledger and measures `reservedAt − assessedAt`.
  A backward step during the 600 ms lock wait makes the difference small or
  negative. The ledger's behaviour (sample the instant after acquiring the lock)
  is unaffected.
- **CORE-06 T7**: the test slept a fixed `remaining + 250 ms` with `setTimeout`
  (monotonic), then exercised the grant. The exercise gate reads the in-process
  wall clock (`new Date()` in the composition). If the wall clock fell more than
  250 ms behind during the sleep, the gate's "now" was still before the expiry,
  the grant was correctly **not yet expired**, and the adapter ran — the
  observed `8 !== 7`. The gate's expiry rule (`now >= expiry`,
  `grant-exercise-assessment.ts:136`) is correct.

### 5.3 Test-only fixes (no production change)

- **SQLite**: the injected clock is wall-clock-shaped but advanced by
  `performance.now()` from a single wall-clock origin. The assertion
  (reservation instant ≥ lock hold − 150 ms, and that instant is persisted) is
  unchanged.
- **T7**: wait until the Host's own clock (`Date.now()`, the same in-process
  clock the gate reads) is past `expiresAt + 250 ms`, polling every 50 ms,
  bounded by a monotonic deadline (`remaining + 15 s`) so a stuck clock fails
  instead of hanging. The assertions (grant capped at the context's validity;
  exercise withheld with `GRANT_EXERCISE_EXPIRED`; no adapter invocation) are
  unchanged.

The security condition is also enforced deterministically elsewhere, with
injected instants: `execution-determinism.test.ts`,
`governed-action-orchestrator.test.ts`,
`authority-controlled-execution-scenario.test.ts`,
`authority-event-stream-governed-action.test.ts`.

### 5.4 Remaining risk

Other wall-clock-dependent tests may exist in the suite; a repository-wide move
to injected clocks is a shared change and is **not** made here. T7 can still
flake if the wall clock steps backwards in the microseconds between the poll and
the exercise call; the window is now the step size over that gap rather than
the whole sleep. Tracked as a qualification risk for CI hosts with stepped time
sync.

Separately, the child-process launcher tests
(`external-authority-signer-launcher`, `host-preflight` launcher case) use fixed
60 s deadlines that a Host start on the Windows-mounted worktree approaches even
when idle (46–62 s). Under concurrent load they time out. Raising or
load-scaling those deadlines is a shared test change and is **not** made here.

## 6. Validation

| Check | Result |
| --- | --- |
| TRADE-01 tests + PAY-04 structure + `trade-vertical-structure` | 91/91 pass |
| All 51 structural / boundary suites (CORE, NO_BYPASS, PAY-02, PAY-03, PAY-04, PAY-05, PROD-03, TRADE) | 910/910 pass (baseline before changes: 895/895) |
| Negative fixtures A–K (temporary real files, §4) | every violation caught; control K fails nothing; tree clean afterwards |
| `exercise-control-sqlite` write-lock wait, isolated | 10/10 pass |
| CORE-06 Host qualification (incl. T7), isolated, under load | 3/3 runs, 25/25 each |
| `npm run typecheck` / `build` / `lint` / `check:release-coherence` | pass |
| Workspace tests (`npm run test:workspaces`) | 1103/1103 pass, 34 suites, 0 skipped |
| Full root suite, run 1 | 10330 tests: 10316 pass, **1 fail**, 9 skipped, 4 todo |
| Full root suite, run 2 | 10330 tests: 10314 pass, **3 fail**, 9 skipped, 4 todo |

CORE-06 T7 and the SQLite write-lock test passed in both full runs.

The full-run failures are all child-process launch tests hitting their 60 s
limits — `external-authority-signer-launcher.test.mjs` (run 1: the custody
launch, 66 s waiting for posture; run 2: both of its tests) and
`host-preflight.test.mjs` "the launcher runs the preflight first" (run 2: killed
by `spawnSync`'s 60 s timeout, status `null`). Neither file, nor the launchers,
nor the Host differs from `b8ae3a0`. During the runs other worktrees' suites ran
concurrently (load average 21–25); in isolation each Host launch took 46–62 s,
and both files pass 20/20. This is a new environmental qualification risk
(§5.4), not a security failure: the assertions that failed are "exits 1" / "posture
printed", reached only because the process was killed or had not yet started.

The 9 skipped tests are pre-existing opt-in tests; the 4 todos are the
pre-existing PROD-01 F1 SQLite classification item.

## 7. Verdict

**READY FOR TRADE-02**, subject to:

- a TRADE ledger reader added in TRADE-02 must come with its own read-only
  boundary tests (no submit, no sign, no SDK import outside an explicitly
  reviewed, enumerated importer — which would be an architectural decision
  recorded in PAY-02's importer list and the NO_BYPASS inventory, not a TRADE
  exception);
- any TRADE composition edge must be added to `TRADE_COMPOSITION_EDGES`
  explicitly, under review.
