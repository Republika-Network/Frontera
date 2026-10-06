# ANDREW-DEMO-UI-01 — Visual Interactive Frontera Demo

| | |
| --- | --- |
| Branch | `feat/andrew-demo-ui`, from `feat/andrew-demo` @ `5dd6f8b3dbe56ed83c062662739eed3371476779` |
| Commands | `npm run demo:andrew:ui` (REHEARSAL) · `npm run demo:andrew:ui:live` (LIVE • XRPL TESTNET) · `npm run test:andrew-demo-ui` (offline tests) |
| Status | **Offline qualified — REHEARSAL end to end in a real browser, after the presentation redesign (§4, §9.2).** LIVE UI qualification has **not** been run: it needs explicit approval, a READY live preflight and, very likely, an explicit fixture reset first (§7). |

The visual demo lets Andrew *see* the governance flow that `npm run demo:andrew`
proves on the terminal. It adds no governance capability. The browser is a
display. A local backend drives the same P0-11 harness steps over the same
Andrew composition. Frontera decides every outcome, and every value on screen
is read from Frontera's canonical records.

## 1. Architecture

```
Browser (web/app.ts — renders state, posts fixed actions; decides nothing)
   │  HTTP, 127.0.0.1 only, no request bodies
   ▼
Demo backend (tools/andrew-demo-ui/src)
   server.ts      fixed routes · Host/Origin checks · secret guard on every response
   controller.ts  one session · server-side state machine · DTOs · persistence · recovery
   execution-gate.ts  holds the authorized payment before signing until EXECUTE
   │
   ▼
P0-11 harness (tools/andrew-demo-harness) — createScenarioA() steps, runScenarioB(),
   openDemoRun(), runDemoPreflight(), buildDemoSummary(), writeDemoEvidence()
   │
   ▼
Andrew composition (P0-07) on the Enterprise Host — identity, policy, destination
governance (P0-03/P0-04/P0-05), authority ceiling, bounded grant, exercise gate, XRPL adapter
   │
   ▼
XRPL transport — LIVE: the real P0-08 Testnet transport
                 REHEARSAL: the same P0-08 transport over an in-process scripted ledger
```

**Tooling-only refactor of the P0-11 harness.** The refactor lets the CLI and
the UI share one scenario controller. `npm run demo:andrew` is semantically
unchanged; its 39 tests pass unchanged.

| Change | What and why |
| --- | --- |
| `scenarios.ts` | `runScenarioA` became `createScenarioA(context)`: seven step functions (A1–A2, A3, A4, A5–A7, A8, A9, A10), each refusing to run out of order. `runScenarioA` calls them in order with byte-identical terminal output. `readGrants` is exported. `EvidenceClient.verify` also returns the Host's per-check list. |
| `scenarios.ts` `call()` | `fetch` → `node:http` with no client timeout. A governed request whose execution is held at the release point may answer minutes later; undici's fixed 300 s header timeout would turn that into a false failure. |
| `demo.ts` | `DemoRunResources`, `openDemoRun`, `describeDemoFailure`, `buildDemoSummary` and `writeDemoEvidence` were extracted from `runAndrewDemo`, which now calls them in the same order. `openDemoRun` accepts an optional transport observer and transport wrapper; the CLI sets neither. |
| `contracts.ts` / `live-wiring.ts` | `openTransport(..., observe?)`: non-secret lifecycle events. These are `signing` (signer called), `submitting` (blob being sent), and the P0-08 transport's own `onEvent` events (`xrpl.attempt.submitted`, `…validated`, `…submit-uncertain`, …). An observer cannot change a payment; a throwing observer is ignored. |

**Why a release point is needed.** The Host evaluates, issues the bounded
grant, passes the exercise gate and routes to the XRPL adapter within **one**
governed request. There is no separate "execute" API, and inventing one would
be new governance. The only honest place to stop between AUTHORIZED and
EXECUTE is the transport boundary.

`execution-gate.ts` wraps the transport handed to the composition. The adapter's
submission waits there **before anything is signed**:

- **EXECUTE** releases it to the real transport.
- **Stop — do not execute** answers `not-submitted`. That is the adapter
  contract's "proven not to have reached the network".
- A second submission through the same gate is refused and fails the run.

The decision and the grant are untouched; the gate only controls *whether and
when* the already-authorized submission reaches the transport.

**Release window.** The grant lives 600 s. The P0-08 transport refuses to
start a payment with less than 120 s of grant lifetime left
(`grant-lifetime-insufficient`). So EXECUTE must be clicked within **≈ 8
minutes** of AUTHORIZED. The screen shows the exact "release before" time. If
it passes, the transport refuses, nothing is signed, and the run FAILs
honestly; start a new session.

**Frontend stack.** No bundler or UI framework is in the root dependencies, so
none was added. The browser client is dependency-free TypeScript compiled by
`tsc` (`tools/andrew-demo-ui/web/`), with one HTML page and one stylesheet.
The jade palette follows the Frontera brand (`frontera-web`); no brand binary
was copied into this repository.

## 2. Security boundary

| Rule | Enforcement |
| --- | --- |
| Loopback only | `DEMO_UI_HOST = '127.0.0.1'`, no host option (pinned). Any request whose `Host` is not `127.0.0.1:<port>`/`localhost:<port>` gets 421 (DNS rebinding). |
| No cross-site driving | POST needs `x-frontera-demo: 1` (forces a CORS preflight that is never granted). A foreign `Origin` gets 403. |
| No input | POST bodies are refused (400). There is no generic command, path parameter or transaction payload; the backend owns the fixed Andrew composition. |
| Safe DTOs only | `dto.ts` is the only shape sent. It holds no seed, key, credential, signed blob, environment variable or local path. |
| Fail closed | Every response is serialized and then checked by the P0-11 secret guard (registered seeds, generated keys and credentials, plus seed/PEM/blob shapes). On a hit the response is withheld (500 `RESPONSE_WITHHELD`), the run can no longer PASS, and no new session can start. |
| Paths | The state root, secrets file and home directory are named (`<state root>`, `<secrets file>`, `~`) and never shown. The same redaction applies to preflight reasons, the run log, and the served summary and report. |
| Static files | Only `/`, `/app.js` and `/styles.css`. CSP `default-src 'none'; script-src 'self'; …`, `nosniff`, `no-referrer`, `frame-ancestors 'none'`, `no-store`. |
| Secrets | LIVE reads `~/.config/frontera-andrew/testnet.env` on the backend only, through the P0-11 loader (owner-only, mode 600). REHEARSAL never opens it (pinned and tested). |
| Browser | Imports nothing, fetches only its own `/api/…`, uses no storage, and names no secret or endpoint (pinned). It never signs, and never talks to XRPL. |

## 3. Modes

| | REHEARSAL — `npm run demo:andrew:ui` | LIVE • XRPL TESTNET — `npm run demo:andrew:ui:live` |
| --- | --- | --- |
| Label | `REHEARSAL — NO XRPL TRANSACTION` (badge and strip) | `LIVE • XRPL TESTNET` (badge and strip) |
| Ledger | In-process scripted XRPL Testnet (`rehearsal-ledger.ts`). No socket is ever opened. | Real XRPL Testnet, `wss://s.altnet.rippletest.net:51233/`, `network_id` 1 |
| Accounts / keys | Two accounts generated in memory at startup; nothing written | The P0-11 secrets file, backend only |
| Amount | Governs the business scenario itself: **USD 75,000**, settled 1:1 as **75,000 Test RLUSD** on the scripted ledger. The scripted treasury starts at 10,000,000 Test RLUSD per backend start. | Governs and settles the configured Testnet amount (`FRONTERA_ANDREW_LIVE_AMOUNT_USD`, default 10), 1:1 as Test RLUSD. The screen labels it a **scaled Testnet run of the USD 75,000 scenario** and says that USD 75,000 of RLUSD is not sent. If the fixture is funded for 75,000, the same setting runs the full amount and the label disappears. |
| Transport | The real P0-08 transport, signer check and attempt store over the scripted ledger (see note) | The real P0-08 transport |
| Run area | `<state root>/rehearsal/runs/<runId>/` | `<state root>/runs/<runId>/` (default `~/.config/frontera-andrew`) |
| Governance | The real Andrew composition | The real Andrew composition |
| Mainnet | Not possible | Refused at startup (`startAndrewDemoUi`) and by the P0-11 configuration and preflight. There is no fallback. |

**Note on rehearsal signing.** The rehearsal reuses the P0-11 test approach:
the P0-08 signer signs the scripted transaction with an **ephemeral, in-memory
generated key**. That key is never funded, written or sent anywhere, and the
signed blob goes only to the in-process scripted ledger. This exercises the
real settlement gate, signer check and durable attempt store. No real seed
exists in a rehearsal process, and nothing reaches XRPL. Rehearsal transaction
hashes are labelled "this transaction exists on no network".

Non-secret overrides, the same as P0-11 plus a port:

- `FRONTERA_ANDREW_STATE_ROOT`
- `FRONTERA_ANDREW_SECRETS_FILE`
- `FRONTERA_XRPL_TESTNET_ENDPOINT` (Testnet only)
- `FRONTERA_ANDREW_LIVE_AMOUNT_USD` (default 10; LIVE only — REHEARSAL always governs USD 75,000)
- `FRONTERA_ANDREW_UI_PORT` (default 4317)

## 4. Screen flow

The screen tells the Andrew/LUMX story in plain language: request, policy,
authority, approval, authorization, execution, outcome and receipt. Internal
identifiers, reason codes, ASSURE-01 check names, `network_id` and phase names
stay available under **Details**, and in full on the **Technical evidence** tab.

**Amount model (`StoryDto`).** The backend publishes the business amount
(USD 75,000, the P0-11 `PRODUCTION_MOTIVATING_EXAMPLE_USD`), the amount this run
governs, the amount it settles (always equal, 1:1 as Test RLUSD), and
`scaled`. REHEARSAL governs and settles the full 75,000 (`scaled: false`).
LIVE governs and settles the configured Testnet amount (`scaled: true` unless it
is 75,000). Every place that states what *this run* did uses the run's amount.
With `scaled`, it adds "scaled Testnet run of the $75,000 scenario".

**Layout (Demo tab):**

1. **Header and mode strip.** Rehearsal or Live, with what that means.
2. **Hero.** *Agent request — Send $75,000 — To a new wallet*, with the
   wallet, the requesting agent, the destination state (Never approved →
   Approved), the USD 100,000 authority ceiling and the settlement. LIVE adds
   a scale notice: "Frontera governs and settles $10 as 10 Test RLUSD in this
   run. $75,000 of RLUSD is not sent."
3. **Stepper.** Request · Blocked · Approve destination · Reconsider ·
   Authorized · Execute · Confirmed · Receipt. Below it, the grants,
   signatures and submissions *measured at the payment boundary*.
4. **Story panels.** The current step is expanded and highlighted, and so is
   the step just completed. Earlier steps collapse to one-line summaries
   (expandable). Future steps appear only in the stepper.
5. **Integrity proofs** (collapsed): retry returns the same decision, a second
   realization is refused, the original decision is unchanged.
6. **Second control test** (authority ceiling), prompted once the first
   scenario is complete.
7. **Result card** at the top once the backend has finished the run.

| Step | Button | Shown by default |
| --- | --- | --- |
| Get ready | Check readiness · Start the demo | Plain checklist: ledger connected, wallets can hold Test RLUSD, treasury balance vs. amount needed, earlier payments settled, signing keys location. Not ready → reasons; the demo never funds or lowers the amount. A finished run collapses this to "Start a new session". |
| 1 Request | Send the request to Frontera | Agent, action, amount, destination (never approved). |
| 2 Blocked | — | **Execution blocked — Destination not approved.** Agent recognized ✓ · Destination ✕ · Amount – (under the ceiling, *not reached*: the destination check stopped it first). *No grant issued · No signature created · No transaction submitted* (from measured counters). |
| 3 Approve destination | Approve destination | Wallet, Not approved → Approved, approver, role, authority basis, time. **No payment occurred.** The button first runs the replay proof (A3), which the backend requires before approval, then the approval (A4). Two separate backend-checked actions. |
| 4 Reconsider | Reconsider the request | "The same payment request is evaluated again after the destination becomes approved." |
| 5 Authorized | — | **Payment authorized.** Governed amount, destination approved, authority ceiling (within), grant issued, bound to this request, valid until. |
| 6 Execute | **Execute payment** / **Execute on XRPL Testnet** (dominant) · *Stop — don't execute* (secondary) | "Frontera has authorized the action. No payment has been signed or submitted yet." Authorized amount, destination, network, and a **live countdown** to the backend's release deadline. |
| 7 Confirmed | — | Lifecycle Authorized → Released → Signed → Submitted → Validated → Confirmed with the real times. **Payment confirmed**: transaction hash (copy), ledger, amount delivered, network, from, to. No explorer link (§10). |
| 8 Receipt | Verify evidence and issue the receipt | One **governance receipt**: request, decision (initially blocked), governance action, reconsideration, authorization, execution, outcome, evidence (trace verified, report links once written). |
| Finish | Run the integrity proofs | A9 then A10, each a separate backend-checked action. |
| Second control test | Run the second control test | Approved destination, $125,000 requested, $100,000 ceiling. "Policy permits this kind of payment, but this agent does not have authority for this amount." **Authorization withheld.** *No grant · No signature · No chain execution*. |

**What sits under Details:** reason codes (with plain-language labels), request,
decision, grant, execution and business-intent IDs, ASSURE-01 final state and
check list, engine result, attempt state, the full lifecycle detail, and Scenario
B's policy decision (`allowed`), issuance outcome (`withheld` by
`authority-binding`) and issuance record.

**The countdown** is the only clock on the page. It displays the time left
before the backend's `releaseDeadline`, and it changes no state and triggers no
action.

**Technical evidence tab:** run facts (including business, governed and
settled amounts), the Scenario A and B evidence tables, checkpoints, the run
log, and the summary/report links.

## 5. State machine (server-side, enforced)

```
not-started ─request→ denied ─replay→ replayed ─approve→ approved ─reconsider→ authorized
   ─execute→ executing ─(transport outcome checked)→ confirmed ─verifyEvidence→ evidence-verified
   ─reconsiderAgain→ refused-second ─historical→ complete
authorized ─abandon→ failed (nothing signed)        any harness failure → failed
Scenario B: locked → (after approve; nothing in flight) → blocked | failed
PASS ⇔ complete ∧ B blocked ∧ invariants held ∧ evidence written
```

- `allowed` is one table (`DemoController.allowedActions`). The browser uses it
  to enable buttons, and every action re-checks it (`ActionRefused` → HTTP 409).
- Only one action runs at a time.
- A new session needs:
  - a **fresh** READY preflight;
  - no unresolved XRPL attempt (review);
  - no payment in flight.

  It gets a new run ID, a new run directory and fresh Host state. The
  destination is always `never-approved` at start, and nothing is inherited.
- Execution: `POST /api/scenario-a/execute` returns once the held submission
  is released. The browser polls `/api/status` only while the backend reports
  work in progress, so the lifecycle advances only when backend state does.

**API.**

- `GET`: `/api/status`, `/api/scenario-a`, `/api/scenario-b`, `/api/evidence`,
  `/api/summary`, `/api/report[?download=1]`.
- `POST` (no body): `/api/preflight`, `/api/session`.
- `POST` (no body), Scenario A:
  - `/api/scenario-a/{request,replay,approve,reconsider,execute,abandon}`;
  - `/api/scenario-a/{verify-evidence,reconsider-again,historical}`.
- `POST` (no body): `/api/scenario-b/run`.

## 6. Run state, refresh and recovery

- **Persistence:** `<run>/ui-state.json` (mode 600, secret-guarded) is a
  non-secret snapshot, written after each transition beside the P0-11 run
  records (`run.json`, `host/`, `xrpl-attempts.sqlite`, `evidence/`,
  `summary.json`, report).
- **Browser refresh:** the backend is the source of truth, and `/api/status`
  returns exactly what it holds.
- **Backend restart:** the latest snapshot is shown **read-only**. An active
  session becomes `interrupted` (FAIL). It can never resume, because its Host,
  keys and credentials lived in the stopped process.
- **Review decision:** whether a restart blocks further payments is decided by
  the attempt stores, not the snapshot. The P0-11 rule `unresolvedAttemptReasons`
  is applied to every treasury these runs used. `signed`, `submitted`,
  `submit-uncertain`, `unresolved` and `anomaly` mean **EXECUTION STATE
  REQUIRES REVIEW**: every payment control is disabled and no new session can
  start. An interruption *before signing* has no attempt row and blocks
  nothing.

## 7. Prerequisites and fixture

- Run `npm ci`. The commands build the tool with
  `tsc -b tools/andrew-demo-ui tools/andrew-demo-ui/web`; like `demo:andrew`,
  they assume the root `dist/` is built (`npm run build`).
- LIVE also needs the P0-11 secrets file, owner-only, with the treasury seed
  and both addresses; both accounts funded with Test XRP; both RLUSD trust
  lines; and treasury Test RLUSD ≥ the demo amount.
- **Funding / reset is always explicit and outside the demo.** The UI never
  refills, resets, faucets or lowers the amount. A NOT READY preflight says
  `FUNDING REQUIRED …`. After the last P0-11 live run, 10 Test RLUSD sit with
  the recipient. A reset is the same kind of explicit operator action recorded
  in ANDREW-P0-11 §11.2: the recipient returns 10 Test RLUSD to the treasury.
  It is ungoverned setup provenance, never demo evidence.

## 8. Recovering from an ambiguous attempt

1. The screen shows **EXECUTION STATE REQUIRES REVIEW** with the run,
   execution id and transaction hash.
2. Do not start another payment. Re-read the transaction on XRPL Testnet by
   its hash with the P0-08 transport's `recheck(executionId)` over that run's
   `xrpl-attempts.sqlite`. It never signs or submits. It waits for a validated
   answer and records the settled state (`validated-success`, `validated-tec`
   or `expired`) in the attempt store.
3. Run the preflight again. The review clears by itself because it is
   recomputed from the attempt stores. If the ledger cannot settle the
   attempt, it stays blocked; that is deliberate.
4. Never delete an attempt store to clear a review.

## 9. Test results (offline, 2026-10-06)

No live XRPL transaction was made. No live preflight was run; the LIVE path
was exercised only with the real configuration loader, the real P0-08
transport and a scripted Testnet.

| Check | Result |
| --- | --- |
| `npm run build` / `npm run typecheck` | pass |
| `npm run lint` (Node16 imports, architecture, public surface) | pass |
| `npm run test:andrew-demo-ui` | **32 / 32** |
| `npm run test:andrew-demo` (P0-11 harness, after the refactor) | **39 / 39** |
| Structure pins: `andrew-demo-ui-structure` + `andrew-p011-structure` | **14 / 14** |
| Focused root regression: 50 files, every `andrew*`, `destination*`, `assure*`, `xrpl*`, `*structure*` and `*boundar*` suite under `src/enterprise/__tests__` | **908 / 908** (the two opt-in live Testnet suites report `# SKIP`, as designed) |
| `git diff --check`, conflict markers, secret-shape scan of the diff | clean |
| Browser (headless Chromium 1440×900, 1000 px, 390 px), full REHEARSAL flow | PASS, no console errors, no horizontal overflow; state restored after a page reload and after a backend restart |

**The 32 UI tests, by requirement number of the brief:**

- **LIVE over HTTP, end to end:**
  - loopback bind and LIVE label (28);
  - every governed action refused before READY and a session (3, 13);
  - fresh unapproved session (7);
  - canonical denial with zero counters (8);
  - replay with the same decision (9);
  - approval executes nothing and does not advance (10);
  - linkage and exactly one grant with nothing signed, no auto-execution (11, 12);
  - refresh restores state (23);
  - one signature and one submission with the real lifecycle sequence (15);
  - no second execution (14);
  - evidence equal to the attempt and grant stores (16);
  - second reconsideration refused (17);
  - Scenario B approved, 125,000 / 100,000, the exact reason, zero transport activity (19–22);
  - historical denial unchanged, then PASS (18);
  - summary and report equal to the displayed evidence; traversal and unknown paths 404 (16, 26);
  - every response body scanned: no seed, private key, credential, blob, secret name or local path (4–6);
  - a new session after PASS is fresh and unapproved (7).
- **HTTP boundary:**
  - bodies refused and out-of-order finishing steps refused, so PASS cannot be fabricated (25);
  - missing header, foreign Origin and foreign Host refused;
  - static allowlist and CSP;
  - the secret guard withholds a response and blocks the run.
- **REHEARSAL:**
  - labelled; never opens the secrets file (it is given a world-readable one); own run area (27);
  - the whole story to PASS through the same harness steps, labelled scripted (27);
  - stopping at AUTHORIZED signs and submits nothing and is never PASS;
  - after a backend restart, the recovered run shows its own recipient and
    accounts, never the restarted process's newly generated ones (23).
- **LIVE fails closed:**
  - Mainnet refused, by the controller and at startup (1, 3);
  - `network_id` 0 refused (2);
  - insufficient Test RLUSD: funding instruction, nothing refilled (3);
  - group-readable secrets file refused, with its path redacted;
  - an unresolved earlier attempt means REVIEW and no session (24);
  - a restart mid-execution with a `submitted` attempt is recovered read-only and blocks (23, 24);
  - an interruption before signing needs no review.

**Visual review** (screenshots are kept locally, not committed; the repo has no
convention for demo screenshots):

- Covered: initial and preflight; BLOCKED; approval; AUTHORIZED; CONFIRMED
  (rehearsal); ASSURE evidence with the check list; authority-ceiling BLOCKED;
  final PASS; Evidence tab; mobile.
- Fixed during review:
  - the stretched preflight chip;
  - a `not-applicable` verification check drawn as a failure (now neutral,
    with an "n of N passed, 0 failed" headline);
  - checkpoint chips overlapping the detail column;
  - the transaction hash wrapping beside the copy button;
  - a finished session still offering "START DEMO SESSION" as the primary
    action;
  - **a real leak, found by test:** the run directory path in the run log and
    the verification-file paths in the served summary. Both are now redacted.

### 9.1 Second offline qualification pass (2026-10-06)

Every Node process in this pass, including tests, builds, the browser-driven
backend and the differential run, ran under a preload network guard. The
guard refuses and logs any non-loopback TCP or TLS connection.

| # | Check | Result |
| --- | --- | --- |
| 1–2 | Build root, P0-11 harness and UI (server + web); `tsc --noEmit` of each | pass |
| 3 | `npm run lint`, `node --check` of the entry script, `package.json` parse | pass |
| 4 | `npm run test:andrew-demo-ui` | **32 / 32** |
| 5, 7 | `andrew-demo-ui-structure` + `andrew-p011-structure` | **14 / 14** |
| 6 | `npm run test:andrew-demo` | **39 / 39** |
| 8 | Full REHEARSAL flow in Chromium from a fresh state root and a fresh session | PASS, no console errors, no overflow at 390 / 1000 px |
| 9 | Refresh: two `/api/status` reads after PASS; page reload | byte-identical; PASS view restored |
| 10 | Backend restart (SIGTERM, then restart on the same root) | Scenario A, Scenario B, verdict, checkpoints, run accounts and session identical. Only `preflight` (current process, not run yet) and the in-memory run log differ. Summary and report still served (200); execute refused (409); only preflight and new session allowed. |
| 11–12 | `git diff --check`; conflict markers | clean |
| 13 | Seed, private-key, signed-blob, credential, secret-name and local-path scans of the diff, every browser-served payload of the run (status before and after restart, evidence, scenario A/B, summary, report) and the on-disk UI snapshot | clean. The only diff hits are test fixtures that write a temporary secrets file from freshly generated wallets at test time, and the literal `not-a-seed`. |
| 14 | `npm run demo:andrew` unchanged: the baseline harness (`5dd6f8b`, extracted to a temporary copy) and this branch's harness, both through `runAndrewDemo` over the same scripted Testnet, for three cases: full PASS, Mainnet NOT READY, interrupted after A4 | terminal output (136 lines for PASS), `summary.json`, report, verdict, exit code and submission count **identical** after normalizing run-specific ids, timestamps, hashes and addresses |
| 15 | No live XRPL connection | 54 guarded processes, **0** blocked connections (besides the guard's own deliberate self-test). The live state root is untouched: only run `andrew-20261006T021642Z-a92769`, `testnet.env` last modified 2026-10-04. |

**Defects found and fixed in this pass:**

- After a rehearsal backend restart, the recovered run's step cards showed the
  restarted process's newly generated recipient instead of the run's own.
- The facts bar showed the new process's accounts beside an older recovered
  run.

The backend now exposes the run's own accounts, from the session
configuration or the run's `run.json`. The preflight card says when its
accounts are for the next session. A regression test was added.

### 9.2 Presentation redesign pass (2026-10-06)

Files changed: `web/app.ts` and `web/styles.css` (rewritten); `src/dto.ts`
(`StoryDto`); `src/controller.ts` (`story()`, rehearsal balance);
`src/rehearsal-ledger.ts` (governs USD 75,000; scripted limits raised);
`src/__tests__/andrew-demo-ui.test.ts`; this document. There were no harness,
production, PROD-03 or ASSURE-01 changes, and the allowed-actions table is
unchanged.

| Check | Result |
| --- | --- |
| `npm run test:andrew-demo-ui` | **32 / 32**, now also pinning the amount model: REHEARSAL governs, holds and delivers 75,000 and debits the scripted treasury by exactly 75,000; LIVE reports `scaled: true` with governed = settled = delivered = 10; the held 75,000 payment has 0 signatures and 0 submissions before EXECUTE; the ceiling test's grants, connections, signatures, submissions and attempt rows are all 0 and its transaction is null |
| `npm run test:andrew-demo` | **39 / 39** (harness unchanged) |
| `andrew-demo-ui-structure` | **8 / 8** |
| Browser, REHEARSAL, full flow (Chromium 1440 px and 390 px), backend under a loopback-only network guard | PASS; 75,000 delivered; "$75,000" shown 8 times; no console errors, no horizontal overflow; **0** non-loopback connection attempts |
| Browser, LIVE mode over a scripted Testnet (real configuration loader and transport, temporary secrets file), under the same guard | Scale notice, "Testnet settlement 10 Test RLUSD", "$10 (scaled Testnet run of the $75,000 scenario)", receipt "$75,000 scenario · governed at $10", "10 Test RLUSD delivered"; **0** non-loopback connection attempts |

## 10. Known limitations

- **No Testnet explorer link.** The repository has no Testnet explorer URL
  convention, so none was invented; the hash can be copied.
- **No resume after a backend restart.** The run's Host, keys and credentials
  lived in the stopped process, so a restarted backend shows the run read-only
  and fails it. The in-memory run log is not persisted; the written report
  carries the same story.
- **Release window.** EXECUTE must come within ≈ 8 minutes of AUTHORIZED
  (§1).
- **Scenario B and Scenario A share one session.** B needs the session's own
  step-4 approval. That reuses the P0-11 run's governance state on purpose and
  never inherits an earlier run.
- **Rehearsal balance.** The rehearsal ledger starts at 10,000,000 Test RLUSD
  per backend start (over 130 full runs) and debits 75,000 per scripted payment.
- **Live amount.** LIVE governs only what the Testnet fixture can settle. A
  full USD 75,000 live run needs ≥ 75,000 Test RLUSD in the treasury and
  `FRONTERA_ANDREW_LIVE_AMOUNT_USD=75000`. Funding stays explicit and outside
  the demo.
- **Approve runs the replay proof first.** The backend's order (A3 before A4)
  is unchanged; the Approve button sends both, as separate checked actions.
- **Single operator.** One backend serves one browser session at a time.
  Concurrent browsers see the same state, and actions are serialized.

## 11. Live UI qualification — NOT YET RUN

It requires explicit approval. The sequence will be:

1. **Read-only preflight:** `npm run demo:andrew:preflight`. It must be
   READY. After the last P0-11 run the treasury most likely holds 0 Test
   RLUSD, so expect `FUNDING REQUIRED` and an explicit, separately approved
   fixture reset (§7).
2. **Launch:** `npm run demo:andrew:ui:live`, then open
   `http://127.0.0.1:4317/`.
3. **Scenario A:** RUN PREFLIGHT → START DEMO SESSION → steps 1–10. EXECUTE
   is the only click that signs and submits.
4. **Scenario B:** run it from the Authority Ceiling tab.
5. **Verify:** exactly one new Testnet transaction (attempt store plus a
   ledger re-read), zero XRPL activity for B, ASSURE-01 verified, and the
   final PASS with summary and report.
