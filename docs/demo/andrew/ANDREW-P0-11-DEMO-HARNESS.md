# ANDREW-P0-11 — Deterministic One-Command Demo Harness and Evidence Summary

| | |
| --- | --- |
| Branch | `feat/andrew-p0-11-demo-harness`, from `feat/andrew-demo` @ `d167be3805066466b16a09c05fc84a96e2c9bf48` |
| Command | `npm run demo:andrew` (live) · `npm run demo:andrew:preflight` (read-only) · `npm run test:andrew-demo` (offline harness tests) |
| Status | **VERIFIED — live one-command demo PASS** on XRPL Testnet, run `andrew-20261006T021642Z-a92769` (§11). Merged into `feat/andrew-demo`. |

P0-11 adds no product capability and no governance semantics. It turns what
P0-08 (real XRPL Testnet transport), P0-09 (linked reconsideration) and P0-10
(durable authority-ceiling withholding) proved into one opt-in, deterministic,
operator-friendly run. The run prints a readable story and writes a
non-secret, machine-readable evidence summary.

## 1. Where it lives, and why

| Path | Role |
| --- | --- |
| `tools/andrew-demo-harness/` | A typed TypeScript project (`tsconfig.json` → its own `dist/`). Not a workspace, not referenced by the root build, not on any root test glob, and outside `src/`, `packages/` and `apps/`. |
| `tools/andrew-demo-harness/src/live-wiring.ts` | The only harness module that imports the P0-08 transport package. It binds the real Testnet ports and counts every connection, signature and submission. |
| `scripts/run-andrew-demo.mjs` | The opt-in executable. It only wires the parts together, forwards four non-secret overrides and never sets a test seam. |
| `src/enterprise/__tests__/andrew-p011-structure.test.ts` | Pins the boundary in the normal root suite. |

The P0-07 structural rule "no production source outside the demo imports the
Andrew demo" (pin 108) scans `src`, `packages` and `apps`. A harness under
`src/enterprise` or `packages/` would break it, so the harness lives in
`tools/`. Pin 108 is unchanged, and no structural pin was relaxed.

**Not run accidentally:**

- `npm test`, `test:root`, `build`, `typecheck`, the start scripts and
  `validate:publishability` never reference it (pinned).
- The root package publishes `dist/` only, and the tool builds into
  `tools/andrew-demo-harness/dist`.

## 2. The run

```
npm run demo:andrew
  └ configuration (secrets file, owner-only; Testnet endpoint; amount rules)
  └ PREFLIGHT (read-only) ──── NOT READY → print reasons, exit 2, no governed action
  └ run directory (fresh) + manifest
  └ run infrastructure: generated Ed25519 authority key, run-scoped CORE-07 witness, generated credentials
  └ composeAndrewDemo (P0-07) with the real Testnet transport (P0-08)
  └ SCENARIO A  A1 … A10
  └ SCENARIO B  B
  └ summary.json + ANDREW-DEMO-<runId>.md
  └ DEMO RESULT: PASS (exit 0) — or FAIL with its category (exit 1)
```

### Fresh state per run

Every run gets `<stateRoot>/runs/<runId>/` (default stateRoot
`~/.config/frontera-andrew`). A run directory is never reused. It contains:

| Path | Contents |
| --- | --- |
| `run.json` | Manifest: demo identity, network and treasury. Written before any payment. |
| `host/` | All Host and destination-governance state. Scenario A therefore always starts with the destination `never-approved`, and the harness asserts this. |
| `witness/` | The freshness witness's own database, never beside an authority store. |
| `xrpl-attempts.sqlite` | Fresh; asserted empty before Scenario A. |
| `evidence/` | `authority-verification-keys.json` (the run's Ed25519 authority public key) and `witness-public-key.pem`. |
| `summary.json`, `ANDREW-DEMO-<runId>.md` | The evidence summary and its Markdown rendering. |

### Run infrastructure

- **Authority authenticity:** a fresh Ed25519 authority signing key per run.
  The private half lives in memory only. The public verification material is
  written to `evidence/` and referenced by `summary.json`, so the run's grants
  remain independently verifiable afterwards.
- **Freshness witness:** the product's reference witness
  (`startReferenceAuthorityStateWitness`). It is started explicitly, scoped to
  `witness/`, has its own random token and receipt key, and is closed in a
  `finally` on success or failure.
- **Credentials:** random agent, operator and auditor credentials, in memory
  only.
- **No test fixtures:** nothing from the test fixtures (`secureEnv`, the test
  authority keys, `withDeploymentWitness`) is used.

## 3. Preflight

The preflight is read-only and gives a single verdict, **READY** or
**NOT READY**, with precise non-secret reasons.

**Checks:**

- **Secrets file:** exists, is a regular file, is owned by the user and is
  mode 600. It is parsed into memory only, and every `*SEED*`/`*SECRET*`/`*KEY*`
  value is registered with the secret guard.
- **Endpoint:** `wss://` with no credentials, and not a Mainnet server. The
  default is the documented Testnet endpoint, and there is no Mainnet fallback.
- **Network:** the connected `network_id` must be 1.
- **Signing seed:** the treasury seed derives the treasury address. This is
  checked without any network.
- **Accounts:** neither account is an RLUSD issuer.
- **Ledger readiness:**
  - treasury and recipient XRP;
  - both RLUSD trust lines;
  - the recipient trust limit;
  - the treasury's Test RLUSD at or above the demo amount.
- **Unresolved attempts:** no earlier run of this demo has an unsettled XRPL
  attempt. The scan is scoped to the same demo identity, XRPL Testnet and the
  same treasury, so unrelated development runs cannot block the demo. The
  states `signed`, `submitted`, `submit-uncertain`, `unresolved` and `anomaly`
  fail closed.

**Funding:** the demo never refills, resets or faucets the fixture, and never
lowers the amount. Insufficient Test RLUSD is reported as
`FUNDING REQUIRED — … Fund the treasury with at least <amount> Test RLUSD (or
run an explicit fixture reset), then rerun.` No reset helper was added.

## 4. Amount honesty

| Amount | What it is |
| --- | --- |
| **Governed amount** | USD `FRONTERA_ANDREW_LIVE_AMOUNT_USD`, default **10** (the P0-08/P0-09 rules apply). |
| **Testnet transfer** | The same number of **Test RLUSD on XRPL Testnet**. It has no real-world value. |
| **Production motivating example** | **USD 75,000** (Andrew/LUMX). Illustrative only, never sent and never a funding requirement. |
| **Scenario B request** | **USD 125,000**. A governed request that is withheld; nothing moves. |

The terminal and the summary keep these four apart, and the harness tests pin
that 75,000 and 125,000 never appear as delivered amounts.

## 5. Scenarios

**Scenario A**

| Step | What the harness requires (from canonical records) |
| --- | --- |
| A1 | Destination registered, `never-approved` on fresh state; every counter 0 |
| A2 | `denied` with `DOMAIN_POLICY_DENIED`, which is an EXPECTED GOVERNANCE DENIAL. 0 grants, connections, signatures, submissions and attempt rows; the original trace verifies. |
| A3 | Exact replay returns the identical committed decision: no re-evaluation, no new execution |
| A4 | P0-03 approval, attributed to the operator with role and authority basis; approval alone executed nothing (counters unchanged) |
| A5 | Fresh request, same business intent. The trace lineage names the denied original, the shared business-intent id and the reason. |
| A6 | Fresh `allowed` decision. The one bounded grant is bound to it, with an amount ceiling of USD 100,000. |
| A7 | Exactly 1 grant, 1 signature, 1 submission and 1 attempt row; attempt `validated-success`. An independent ledger re-read confirms validated, `tesSUCCESS`, delivered Testnet RLUSD equal to the amount, and the right source and destination. |
| A8 | The ASSURE-01 trace is `executed-confirmed-completed`, names the same execution, grant and hash, records the realization, and verifies |
| A9 | A second reconsideration is withheld with `GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED`, which is an EXPECTED DUPLICATE REFUSAL; counters unchanged |
| A10 | The original answers its identical historical denial; its trace verifies, unrewritten |

**Scenario B**

- **Setup:** reuses governance state only to confirm the destination is
  approved. It reads no ledger and needs no funding.
- **Required result:** `withheld`, `authority-binding`, exactly
  `[FINANCIAL_AUTHORITY_CEILING_EXCEEDED]`, on a Kernel-`allowed` decision. No
  execution id and no provider reference.
- **Counters:** grant, connection, signature, submission and attempt-row
  deltas are all 0. Any non-zero delta fails the run.
- **Evidence:** the trace shows
  `authority.presence: recorded` and
  `issuance {withheld, authority-binding, requested USD 125000, ceiling USD 100000}`,
  with `finalState: not-executed`. It verifies, and the durable
  `issuance_record` row is read from the Governance Store.

## 6. Failure behaviour

- **Failure categories:** `PRECONDITION FAILURE`, `GOVERNANCE DENIAL` (an
  unexpected one), `XRPL SUBMISSION FAILURE`, `XRPL VALIDATION FAILURE`,
  `EVIDENCE VERIFICATION FAILURE`, `UNEXPECTED DEMO ASSERTION FAILURE`.
- **Expected blocks pass:** expected blocks are recorded as passing checkpoints
  (`EXPECTED GOVERNANCE DENIAL`, `EXPECTED AUTHORITY WITHHOLDING`,
  `EXPECTED DUPLICATE REFUSAL`) and pass only with the exact expected reason.
- **What fails the run:** a wrong reason, an unexpected grant, signature,
  submission or connection, an ambiguous XRPL outcome, a trace that does not
  verify, a secret-shaped output, or an interruption (Ctrl-C is honoured at the
  next checkpoint, never mid-submission).
- **On failure:** the process exits 1, the summary records
  `finalVerdict: FAIL` with the category, and `DEMO RESULT: PASS` is never
  printed.

## 7. Secrets

The secret guard refuses any line or file containing:

- a registered secret value (seeds, generated keys, credentials, the witness
  token);
- an XRPL family seed shape (29-character secp256k1 or 31-character Ed25519
  `sEd…`);
- a PEM private key;
- a hex blob of 200 or more characters (a signed transaction).

It never echoes the match.

The harness tests found and fixed one gap during P0-11: the first seed-shape
pattern matched only 29-character seeds. Exact-value matching already covered
the configured seeds, but an unregistered Ed25519 seed would have slipped
through the shape layer.

## 8. Tests

| Suite | Tests | Covers |
| --- | --- | --- |
| `tools/…/andrew-demo-harness.test.ts` | 31 | Uses the real Andrew composition, the real P0-08 transport, signer and attempt store, and a scripted Testnet. It covers:<br>• **Preflight refusals:** (1) Mainnet; (2) wrong network id; (3) insufficient Test RLUSD, with a funding instruction; (4) missing trust line; (5) an unresolved attempt from an earlier run, scoped by treasury; a group- or world-readable secrets file; a seed that does not match the treasury.<br>• **One complete run** with overall PASS (exit 0): (8) the denial is an expected PASS; (9) replay; (10) approval executes nothing; (11) exactly 1 grant, signature and submission; (12) second reconsideration refused; (13) historical denial kept; (14) Scenario B expected withholding with all deltas 0; (18) the summary equals the attempt store, grant store and Governance Store rows; (6, 7, 19) no seed, blob or key in the terminal, summary, report or evidence files; the amounts kept apart.<br>• **Failures, each exiting 1 with no PASS printed:** (15) an unexpected grant in B; (16) unexpected XRPL activity in B; (17) a trace verification failure; (20) an interruption; a validated `tec`; the ledger re-read disagreeing on engine result or delivered amount; a wrong A2 reason; a re-evaluated replay; a lost linkage; a second execution; a rewritten history; a wrong B reason. |
| `tools/…/andrew-demo-rules.test.ts` | 8 | The pure step rules against wrong answers; the secret guard and presenter |
| `src/enterprise/__tests__/andrew-p011-structure.test.ts` | 6 | In the root suite, pins: tool location; nothing in the product imports it; no workspace, build reference or root test glob includes it; only the 3 explicit scripts invoke it; its core imports no transport, xrpl or test fixture and no `process.env`; the entry script forwards only non-secret overrides and sets no test seam; Testnet default; no seed, key or Mainnet endpoint |

`npm run test:andrew-demo`: **39 / 39** pass. Structure: **6 / 6** pass.

The harness has two test seams, used only by these tests and pinned absent
from the live command:

- `observer` (notified after checkpoints, and after Scenario B's request);
- `intercept` (substitutes an observed reply or trace, to prove the rules
  reject answers a correct Host never gives).

## 9. Mutation campaign

Each mutant was applied in the harness source, rebuilt, and run against the
39 harness tests.

| # | Mutant | Result |
| --- | --- | --- |
| M1 | initial denial treated as failure | killed (25) |
| M2 | any denial accepted regardless of reason | killed (2) |
| M3 | destination approval skipped | killed (22) |
| M4 | idempotent replay proof skipped | killed (1) |
| M5 | reconsideration linkage assertion skipped | killed (1) |
| M6a / M6b | second-reconsideration check skipped / a second execution accepted | killed (1 / 2) |
| M7a / M7b | ledger engine result ignored / `tec` not classified | killed (1 / 1) |
| M8 | delivered-amount mismatch ignored | killed (1) |
| M9 | trace verification failure ignored | killed (1) |
| M10 | Scenario B grant allowed | killed (1) |
| M11 | Scenario B XRPL connection or submission allowed | killed (1) |
| M12 | fabricated transaction hash in the summary | killed (1) |
| M13 | PASS reported after a failed stage | killed (13); the first form only failed to compile and was re-expressed |
| M14a / M14b | secret guard disabled / treasury seed printed | killed (2 / 18) |
| M15 | Scenario B wrong reason accepted | killed (2) |
| M16 | preflight network id ignored | killed (1) |
| M17 | preflight ledger blockers ignored | killed (2) |
| M18 | unresolved earlier attempts ignored | killed (1) |
| M19 | Mainnet endpoint accepted | killed (1) |
| M20 | interruption ignored | killed (1) |
| M21 | PASS banner printed on failure | killed (13) |

**Result: 24 / 24 killed; 0 equivalent; 0 surviving.**

**Tooling note.** Mutants are restored from a copy whose modification time
predates the mutant's build output, so after the *last* restore `tsc -b`
judged the output up to date and kept that last mutant compiled. Mid-campaign
results are unaffected:

- each new mutant dirties the project, and the incremental rebuild re-emits
  every file whose contents changed;
- the kill counts above (25, 2, 22, 1, …) show mutants did not stack.

Qualification runs after a forced clean rebuild (`tsc -b --force`).

## 10. Qualification

| Gate | Result |
| --- | --- |
| `npm run build` / typecheck (`tsc -b`) | pass |
| `npm run lint` | pass (the explicit-`any` rule was also applied to `tools/` by hand: none) |
| `npm run test:andrew-demo` | **39 / 39** |
| Root suite (`dist/src/**/*.test.js`, `tests/**/*.test.mjs`) | **9,730 tests: 9,714 pass, 3 fail, 9 skipped, 4 todo, 0 cancelled** (1,749 suites). Covers P0-01…P0-11, governed action, destination approval, financial authority, grants, no-bypass, outcome, resolution, receipt, ASSURE-01, the XRPL adapter, and the structural pins. |
| Workspace suites, including the XRPL transport | **1,128 / 1,128** |
| `git diff --check` · conflict markers | clean · none |
| Secret scan of the change | 0 real secret values from the local secrets file; 0 seed-, key- or signed-blob-shaped strings |

**The 3 root failures are inherited.** They fail identically on the untouched
baseline `d167be3`, and all three are the known Windows CRLF source-text
structure tests:

- `structural-boundaries` R004.B;
- `credential-matching` *extractBearerToken — structure*;
- `authority-administration-service` *CTRL-01 structure*.

There are no new failures. The 4 `todo` entries are the documented
FRONTERA-PROD-01 F1 `SQLITE_BUSY` cases.

## 11. Live qualification

### 11.1 First preflight: NOT READY (historical)

Command: `npm run demo:andrew:preflight` (read-only), run 2026-10-05.

| Check | Observed |
| --- | --- |
| Network | XRPL Testnet, connected `network_id` 1; endpoint `wss://s.altnet.rippletest.net:51233/` |
| Treasury / recipient | `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` / `rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` |
| XRP (drops) | treasury 99,999,964; recipient 99,999,976 |
| RLUSD trust lines | both present |
| **Treasury Test RLUSD** | **0**: the P0-09 live run delivered the fixture's 10 to the recipient |
| Attempt state | no unresolved attempt |
| Secrets file | owner-only |
| **Verdict** | **PREFLIGHT NOT READY**: `FUNDING REQUIRED — the demo never refills, resets or faucets the fixture.` Stopped before any governed action (exit 2); no run directory was created. |

The harness did not refill, reset or faucet the fixture, or lower the amount.

### 11.2 Fixture reset: setup provenance only, NOT demo evidence

The fixture was then reset by an explicit operator action **outside the
harness**: the recipient returned 10 Test RLUSD to the treasury.

| | |
| --- | --- |
| Transaction | `6E1B714456DF55AA3D5EAE990116955839C43F081E20A9D8F7A3869A76943DE1` |
| Ledger | 21313149, validated, `tesSUCCESS` |
| Direction | `rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` → `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF`, 10 Test RLUSD |

This transaction is **not governed**. No Frontera request, decision, grant or
trace produced or authorized it. It is not in the run's attempt store, and
nothing in `summary.json` refers to it. It only records how the treasury got
back the 10 Test RLUSD the preflight requires, and must not be cited as
evidence of the demo.

### 11.3 Live run: DEMO RESULT: PASS

Command: `npm run demo:andrew`, one invocation, 2026-10-06T02:16:42.913Z →
02:16:53.683Z (≈ 11 s). Preflight **READY** (treasury 10 Test RLUSD,
`network_id` 1, validated ledger 21313261 at preflight).

| | |
| --- | --- |
| Run ID | `andrew-20261006T021642Z-a92769` |
| Summary | `~/.config/frontera-andrew/runs/andrew-20261006T021642Z-a92769/summary.json` (`frontera.andrew-demo.summary.v1`, `finalVerdict: "PASS"`) |
| Report | `~/.config/frontera-andrew/runs/andrew-20261006T021642Z-a92769/ANDREW-DEMO-andrew-20261006T021642Z-a92769.md` |
| Governed XRPL transaction | `CCA98653E59CF91B5EDDE1E9390DED7B98885E998E0C5D1FA814A8211A78C657` |
| Validated ledger | **21313264** |
| Engine result | **`tesSUCCESS`** |
| Delivered | **10 Test RLUSD** (currency `524C555344000000000000000000000000000000`, issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`), treasury → recipient |
| Governed amount | USD 10. The USD 75,000 production example and the USD 125,000 Scenario B request did not move. |
| **Final** | **`DEMO RESULT: PASS`** (exit 0) |

**Scenario A: PASS**

| Step | Result | Evidence |
| --- | --- | --- |
| A1 | PASS | destination `never-approved` on fresh state |
| A2 | EXPECTED GOVERNANCE DENIAL | `aoc.gar:75b211b810a218b90482bce387ef645e` → `denied`, `DOMAIN_POLICY_DENIED`, `POLICY_ACTION_PROHIBITED` |
| A3 | PASS | replay returned the same committed decision `enforcement-decision-1b4680de-a235-4ded-b351-a3e1df4470e0` |
| A4 | PASS | approval by `operator:andrew-admin` (organization-administrator, `destination.approve`); 0 grants, signatures, submissions |
| A5 | PASS | `aoc.gar:15e28f3583f4d27b66bb5cbd140837e1` linked to the original, business intent `aoc.intent:1e2db7fae4a36f5db0c32cae4ac99486`, reason `destination-approved` |
| A6 | PASS | `allowed` decision `enforcement-decision-5c67e29e-6098-41cb-ae2d-5dbdb4631814`; grant `aoc.grant:0ed1f52b28dd9fbfa75f7c17261790b2`, ceiling USD 100,000 |
| A7 | PASS | execution `aoc.exec:4437c01ed630bf9ae96afe118c5438db`; the hash above at ledger 21313264; attempt `validated-success` |
| A8 | PASS | ASSURE-01 trace `executed-confirmed-completed`, verified |
| A9 | EXPECTED DUPLICATE REFUSAL | `aoc.gar:395146c6eb1fb2594c7c67e08db0cf60` → `withheld`, `GOVERNED_ACTION_RECONSIDERATION_ALREADY_REALIZED` |
| A10 | PASS | historical replay still `denied`, unchanged |

Counters: 1 grant, 1 connection, 1 signature, 1 submission, 1 attempt.

**Scenario B: PASS (EXPECTED AUTHORITY WITHHOLDING)**

| | |
| --- | --- |
| Request / decision | `aoc.gar:88cb12f5e1c49e9abf4769ce1e3ed0b1` / `enforcement-decision-f76888da-c1da-4d45-ae9d-8edf40f57077` (Kernel `allowed`) |
| Requested / ceiling | USD 125,000 / USD 100,000 |
| Outcome | `withheld` by `authority-binding`, **`FINANCIAL_AUTHORITY_CEILING_EXCEEDED`** |
| Issuance record | `aoc.gar.ref:ae8512a76014868e497317a72795c82f` (`withheld:authority-binding:FINANCIAL_AUTHORITY_CEILING_EXCEEDED`) |
| Deltas | grants 0, connections 0, signatures 0, submissions 0, attempt rows 0; no provider reference, no transaction hash |
| ASSURE-01 | `not-executed`, verified |

**ASSURE-01: VERIFIED for both scenarios, 4 / 4 trace verifications.**

- Scenario A: 3 / 3. The original denial (A2), the realized reconsideration
  `executed-confirmed-completed` (A8), and the original again after
  realization (A10).
- Scenario B: 1 / 1, `not-executed`.

The harness fails the run on any trace that does not verify, so a PASS
implies every verification above returned `verified: true`.

### 11.4 Post-run verification of the evidence

Done during finalization, read-only. The live demo was not rerun and the
fixture was not reset again.

- `summary.json` and the Markdown report agree field for field, and both
  record `finalVerdict` PASS.
- The run's `xrpl-attempts.sqlite` holds exactly 1 attempt, for execution
  `aoc.exec:4437c01ed630bf9ae96afe118c5438db` and the governed hash, with
  value 10. `host/bounded-grants.sqlite` holds exactly 1 grant.
- An independent Testnet `tx` lookup of the governed hash returned:
  validated; ledger 21313264; `tesSUCCESS`; `Payment` from the treasury to the
  recipient; delivered 10 Test RLUSD from the issuer above.
- `evidence/` holds only public verification material: the run's Ed25519
  authority public key and the witness public key. The signed transaction blob
  stays in the local attempt store. No seed, private key or signed blob was
  copied into this repository.

### 11.5 Final focused qualification

Run after a forced clean harness rebuild: `tools/andrew-demo-harness/dist`
and its `.tsbuildinfo` deleted, then `tsc -b --force`. No mutation output
from §9 can survive this.

| Gate | Result |
| --- | --- |
| `npm run test:andrew-demo` | **39 / 39** |
| P0-11 structure (`andrew-p011-structure.test`) | **6 / 6** |
| `npm run build` · `npm run typecheck` | pass · pass |
| `npm run lint` | pass (Node16 imports, architecture, public surface) |
| `git diff --check` · conflict markers | clean · 0 |
| Secret scan | 0 matches across the P0-11 change (19 files) and all 3,058 tracked files: no local secret value, no copy of the run's signed blob, and no seed-, private-key- or signed-blob-shaped string |
