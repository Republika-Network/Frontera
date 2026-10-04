# ANDREW-P0-07 — Testnet RLUSD Representation and Demo Composition

| | |
| --- | --- |
| Task | ANDREW-P0-07 — synchronize with `origin/main`; governed USD as RLUSD on XRPL Testnet; compose the demo Host up to, not including, live signing/submission |
| Branch | `feat/andrew-p0-07-testnet-rlusd-composition` |
| Baseline | `f7346f46b8dbe44c9b689473de4d793f80de2253` (`feat/andrew-demo` after the synchronization merge) |
| Status | Implemented and qualified (§13); committed on this branch, merged locally into `feat/andrew-demo`; not pushed |

> **NO transaction was submitted to XRPL in P0-07.** No network connection, no
> account, no seed, no signer. The demo's transport is a recording transport
> that sends nothing and answers `not-submitted`; no transaction hash exists
> anywhere in P0-07. Real signing and submission are P0-08.

## 1. Objective

Keep Frontera governing `{ value: "75000", unit: "USD" }` — authority, policy
and the USD 100,000 ceiling all in USD — and settle that governed USD on XRPL
Testnet as Ripple's RLUSD token, with the identical decimal value, using a
Testnet-scoped destination identity; then compose the complete governed demo
Host so Andrew's two scenarios run end to end up to the transport.

## 2. Phase 0 — Synchronization with `origin/main`

| ref | SHA |
| --- | --- |
| `origin/main` (fetched 2026-10-04) | `e3383b70e7e9c1eac058381652bceb9f99927c88` — merge of PR #163 (ASSURE-01), verified |
| local `main` (stale, untouched) | `57f3369` (36 behind `origin/main`) |
| `feat/andrew-demo` before | `94fbd1999496394e83d79ac87e605e1f09b5aa3a` (14 ahead / 47 behind; merge base `fe277ea`) |
| synchronization merge | `f7346f46b8dbe44c9b689473de4d793f80de2253` (parents `94fbd19`, `e3383b7`) |

Brought in: CTRL-04 (#161), PROD-02 (#162), ASSURE-01 (#163). Merge commit, no
rebase; P0-00 … P0-06 history unchanged.

**One textual conflict, `operator-control/roles.ts`**, resolved as the exact
union (approved by the project owner): CTRL-04's `approval.read/approve/restrict`
and `approver` role unchanged — `approver` holds **no** destination governance;
P0-03's `destination.approve` stays `organization-administrator` only and
`destination.revoke` stays `responder` + `organization-administrator`. A
sentence on the `approver` bullet records why: `approval.approve` decides one
request, `destination.approve` changes a wallet's standing governance state.

**One semantic collision, `ctrl04-structure.test.ts`** (approved resolution):
CTRL-04's repository-wide scan for `authenticated: true` flagged P0-03's two
`DestinationGovernanceAuthority` construction sites. The scan is unchanged; its
exact allowlist now pins three sites (the CTRL-04 bridge and the two P0-03
sites), and a companion test proves the P0-03 sites build no approval command
context and never reach CORE-05. Three mutations (a fourth site, the bridge
moving, a P0-03 site using CORE-05 vocabulary) were each detected.

Synchronized baseline: build, typecheck, lint pass; role matrix verified
directly; 4,449 / 4,450 focused tests (316 files: P0-01 … P0-06, CTRL-04,
ASSURE-01, PROD-02, approvals, evidence, outcomes, operator) — the one failure
is the inherited CRLF artefact (§14).

## 3. RLUSD Parameters — Verified

| | value | source |
| --- | --- | --- |
| currency (160-bit) | `524C555344000000000000000000000000000000` ("RLUSD" zero-padded; re-derived locally) | Ripple, *RLUSD on the XRP Ledger* (docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl) |
| **Testnet issuer** | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | same; independently: xrpl.org *XRPL Payments Skill* ("confirmed"), Ripple `xrpl-mpp-sdk` `RLUSD_TESTNET` |
| Mainnet issuer | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` | Ripple *Token addresses*; **never configured** — held only so it can be refused by name |

Both issuers verify as checksum-valid classic addresses with the in-repo codec.
Receiving RLUSD requires a trust line to the issuer (≥ 1.2 XRP reserve); Testnet
RLUSD comes from Ripple's faucet (tryrlusd.com). Those are P0-08 concerns.

## 4. Governed USD → RLUSD: an Operator-Pinned Rail Representation

```
governed (unchanged):  { value: "75000", unit: "USD" }   ← authority, policy, P10 ceiling, grant
settlement (XRPL):     { currency: <RLUSD hex>, issuer: <Testnet issuer>, value: "75000" }
```

Not FX: no rate, no oracle, no multiplication or division, no conversion
service, nothing a request can choose. The adapter maps the **already
authorized** USD amount after grant/exercise validation; the grant is never
rewritten into another unit.

### 4.1 Codec — 160-bit currency codes (`xrpl-codec.ts`)

`isXrplNonStandardCurrencyCode`: exactly 40 **uppercase** hex digits (one
spelling per code; lowercase refused, never folded), first byte ≠ `0x00`
(that byte marks XRPL's standard layout — a three-letter code or all-zero XRP —
so a `00…` hex code would be a second spelling of a standard code: refused).
No number conversion, no network lookup, no normalization.

### 4.2 Configuration — `kind: 'pinned'` (`contracts.ts`, `configuration.ts`)

```ts
{ assetId: 'USD', representation: { kind: 'pinned', denominates: 'USD', currency: '524C…0000', issuer: 'rQhW…iLKV' } }
```

Accepted only when: `denominates` restates the asset id exactly; the asset id
is a bare governed unit (no rail namespace, no issuer); `currency` is a
canonical 160-bit code (a standard code must use `issued`, where it must equal
the asset — so `EUR` → issued `USD` stays impossible); the issuer is a valid
classic address. Undeclared fields (`rate`, `factor`, `oracle`, `conversion`,
…) are refused. `issued` and `pinned` share one alias space, so one token
cannot carry two governed assets (USD and EUR both pinned to RLUSD → refused).

### 4.3 Network label and the settlement check

The adapter gains an optional `network` label (`xrpl-testnet`) — a label, never
an endpoint (URL-, host- or credential-shaped values refused) — carried on every
submission. `settlement.ts` adds `checkXrplSettlement(profile, submission)`: a
pure check a transport runs **before** signing — no network or another network
→ refused; a token other than the profile's (another issuer, Mainnet RLUSD,
another currency, XRP) → refused; the transport then answers `not-submitted`.
The Andrew settlement module refuses to compose on any drift (§6.1).

## 5. Network-Scoped Destination Identity

**Design: `xrpl.testnet:<classic-address>`.**

Audit before change:

| layer | finding | change |
| --- | --- | --- |
| P0-01 identity | `xrpl.testnet` is a valid namespace; namespaces compared exactly, never folded; P0-01 already requires a test network that shares an address space to be its own namespace | none |
| P0-02 registry | keyed by canonical `namespace:identifier` | none |
| P0-03 approval | scoped to organization + exact destination key | none |
| P0-04 trusted context | facts about the exact requested key | none |
| P0-05 policy | reads approval facts only; no amount/currency | none |
| grants | bind `counterparty = { kind: 'identity', value: 'xrpl.testnet:r…' }` | none |
| P0-06 adapter | serves exactly one configured namespace (`xrpl` or `xrpl.<label>`) | configured to `xrpl.testnet` by the demo |

So a Testnet approval is an approval of `xrpl.testnet:r…` and nothing else:
`xrpl:r…` and `xrpl.mainnet:r…` are different, unapproved destinations (denied),
and even if `xrpl:r…` were registered and approved, the Testnet adapter refuses
it before the transport (`ADAPTER_ERROR`, transport 0). Configuration, not a
global Testnet assumption: the generic destination model is untouched.

## 6. Demo Composition (`src/enterprise/andrew-demo/`)

| file | role |
| --- | --- |
| `rlusd-testnet-settlement.ts` | verified RLUSD constants, `ANDREW_TESTNET_RLUSD_SETTLEMENT`, `assertAndrewSettlement`, adapter options and transport profile derived from one validated settlement |
| `recording-xrpl-transport.ts` | records submissions, runs `checkXrplSettlement`, sends nothing, answers `not-submitted`; never `validated`, never a hash |
| `andrew-demo-composition.ts` | `composeAndrewDemo` |
| `index.ts` | module barrel (not on the Enterprise barrel or API surface) |

`composeAndrewDemo` composes, on `bootEnterpriseHost` and without changing a
generic default: the governed-action file (customer principal = the agent,
CTRL-02 operators, governance profile with the destination material facts,
trusted context sources, USD (and EUR) monetary assets, the transfer route);
the P0-02 registry and P0-03 approval store with the P0-04 provider; the P0-05
policy pack and `assertDestinationPolicyGovernance` at startup; Andrew's
authority world through the provisioning service (owner, agent, passport,
capability, treasury authority with `max_amount USD 100000` and a lifetime
limit, delegation to the agent); the XRPL adapter with the pinned
representation, Testnet namespace and network label; and destination
governance on the CTRL-02 operator plane, built from the Host's own parsed
configuration (`loadEnterpriseHostConfiguration`) so organization, operators,
roles and keys cannot diverge.

Keys, secrets and the authority-state witness are **not** the composition's:
the caller supplies the Host's secure environment (secrets by env reference,
outside the repository). Tests supply it from fixtures; the P0-11 runner will.

### 6.1 Configuration drift fails closed

`assertAndrewSettlement` refuses — before anything opens — another network,
`xrpl` or `xrpl.mainnet` namespace, another currency (including lowercase or a
one-digit change), another governed asset, the Mainnet issuer (by name) or any
other issuer; messages never echo a value. At the transport, an adapter on
Testnet and a transport connected elsewhere refuse the authorized payment
(`network-mismatch`, nothing signed).

### 6.2 Scenario A — measured on the shipped Host

1. `xrpl.testnet:r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zZ` registered; checksum-valid; `never-approved`.
2. USD 75,000 → **denied**; grants 0; transport calls 0.
3. Approval attempts by `responder`, `approver` (CTRL-04) and `observer` → 403; still `never-approved`.
4. `organization-administrator` approves via destination governance; basis `operator-permission:destination.approve;role:organization-administrator;credential:operator`.
5. Replaying the denied request's idempotency key → the original denial (same decision) — idempotency is final (§10).
6. A **fresh** request (new key) → new request, new committed decision; **1 grant** binding `xrpl.testnet:r…` with amount `{ kind: 'ceiling', limit: '100000', unit: 'USD' }`; no RLUSD, issuer or network inside the grant.
7. **Exactly one** submission, settlement check passed, the canonical instruction (§7), `network: 'xrpl-testnet'`, `notAfter` = grant expiry.
8. Host result `execution_failed` / `PROVIDER_UNAVAILABLE` — honestly "not submitted"; no `providerRef`.

### 6.3 Scenario B

Same approved wallet, USD 125,000 → **withheld** `FINANCIAL_AUTHORITY_CEILING_EXCEEDED`; grants unchanged; transport calls unchanged.

## 7. Canonical Payment Instruction for USD 75,000

```json
{"TransactionType":"Payment","Destination":"r92Zr53w6hG5eqX7Zs9Gz2Rq7g7W3FY8zZ","Amount":{"currency":"524C555344000000000000000000000000000000","issuer":"rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV","value":"75000"}}
```

(The destination is the P0-06 synthetic, keyless fixture address; P0-08 replaces
it with a real Testnet recipient.) No `Account`, `Fee`, `Sequence`,
`LastLedgerSequence`, `Flags`, `SendMax`, `Paths`, `DestinationTag` or `Memos`
— exact-amount, same-currency, no partial payment.

## 8. An XRPL Trust Line Is Not a Frontera Approval

The future Testnet recipient may already exist on XRPL, be funded for its
reserve, hold an RLUSD trust line and be technically able to receive RLUSD —
and Frontera still reports `never-approved` and blocks execution. That is the
point of the demo and must stay true. Frontera derives approval **only** from
P0-03 destination governance: the composition and adapter contain no trust
line, account or ledger-query vocabulary (structural test), and no code path
reads XRPL state to decide anything.

## 9. P0-08 Readiness Contract (defined, not implemented)

P0-08 implements `XrplPaymentTransport` **outside** the adapter (live-ledger
vocabulary is banned inside `execution-adapters/xrpl/` by test), likely as its
own module with `xrpl.js` so the core runtime keeps `better-sqlite3` as its only
third-party dependency.

| concern | contract |
| --- | --- |
| first step | `checkXrplSettlement(andrewSettlementProfile(), submission)`; refused → `not-submitted`, nothing signed |
| endpoint | Testnet WebSocket URL from transport configuration (environment), never from the adapter, request or repository; recorded in evidence as a label |
| source `Account` | the treasury account, from transport configuration; the adapter never chooses it |
| fee / autofill | autofill `Fee` and `Sequence` from the connected ledger; cap the fee by configuration |
| sequence | one sequence per `executionId`; never reused across executions |
| `LastLedgerSequence` | set so the transaction cannot validate after the grant's `notAfter` |
| signing | key material from a secret store or environment reference outside the repository; never logged, never in evidence, never in the submission; sign locally |
| idempotency | sign once per `executionId`, persist the signed hash *before* submit; a retry looks up that hash instead of re-signing |
| submit | exactly once; network failure before the submit call → `not-submitted` |
| validated ledger wait | wait for a validated ledger or `LastLedgerSequence` to pass |
| outcome | `tesSUCCESS` validated → `validated`; `tec…` validated → `rejected` (fee charged, no payment); `tem…`/`tef…` → `rejected`; `ter…`, timeouts, not-yet-validated → `unconfirmed` |
| evidence | `transactionHash`, `ledgerIndex`, `engineResult`, `deliveredAmount` (`XrplLedgerEvidence`, defined in P0-07) |
| delivered amount | must equal the instruction's `Amount` exactly; otherwise not `validated` (P0-08 adds this check to the adapter) |
| unconfirmed | hash recorded as `providerRef`; resolved through the existing P12 reconciliation seam; never retried blindly |
| inventory | new egress site with its own EP id in `NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` §7.6 and `no-bypass-effect-paths.test.ts` |

## 10. Re-evaluation (unchanged; P0-09)

P0-07 shows the story with a **fresh** idempotency key after approval, and
proves the replay of the denied key still returns the original denial. The
linked-reconsideration model (P0-06 report) is P0-09 and is not implemented.

## 11. Security Invariants

| # | invariant | proof |
| --- | --- | --- |
| 1 | governed amount, grant and ceilings stay USD | Host test: grant amount `ceiling 100000 USD`, no rail value in the grant; 125K withheld |
| 2 | no FX, no rate | no rate field accepted; value byte-identical; no number conversion (structural) |
| 3 | request cannot choose issuer, currency, network, mapping | 7 forged requests refused, 0 grants, 0 transport; adapter ignores undeclared action fields |
| 4 | EUR cannot use USD → RLUSD | unmapped at adapter; withheld at Host; alias refused at configuration |
| 5 | Testnet approval never authorizes another network | namespace tests (adapter and Host) |
| 6 | tenant isolation | another organization's approval does not count (Host) |
| 7 | drift fails closed | settlement guard; transport `network-mismatch`; issuer/currency drift `token-not-settled` |
| 8 | no key, endpoint or network client in adapter or demo | structural tests |
| 9 | Testnet issuer in exactly one production file; Mainnet issuer only as a refusal | structural test |
| 10 | approval only from destination governance | structural (no trust-line/ledger vocabulary); 403 for non-admin roles |
| 11 | default Host not XRPL-specific | nothing outside the demo imports it; not on barrel/API surface; no dependency |
| 12 | no bypass | NB-001 holder inventory + §7.1 updated; demo never invokes an adapter |

## 12. Tests

| file | tests | covers |
| --- | --- | --- |
| `andrew-p007-rlusd-representation.test.ts` | 33 | RLUSD code vectors and refusals; standard-layout ambiguity; issuers valid; exact USD → RLUSD for six values; determinism; unrepresentable refused; EUR/other units unmapped; request field substitution; namespace refusals; network on submission and P0-06 back-compat; pinned refusals (rate/factor/…, denominates, rail-scoped asset, standard code, issuer, alias); snapshotting; settlement check and profile validation; recording transport; Andrew settlement drift |
| `andrew-p007-composition-host.test.ts` | 11 | Scenario A (14 steps), Scenario B, USD 0.01, EUR, forged requests, namespace isolation, namespace-only change on an approved identity, tenant isolation, composition drift, transport network drift |
| `andrew-p007-structure.test.ts` | 12 | demo file set; no network client/library; no URL/key; no number conversion; no XRPL-state vocabulary; no adapter invocation; issuer placement; adapter names no network/issuer; no generic importer; not on barrel/API; no dependency |
| changed: `xrpl-execution-adapter-structure.test.ts` | — | file set and import allowlist include `settlement.ts` |
| changed: `xrpl-execution-adapter.test.ts` | +1 | `network` is now declared, as a label only (endpoint-shaped values refused) |
| changed: `no-bypass-effect-paths.test.ts` | — | holder inventory + the demo composition |

Mutation testing (each applied, rebuilt, run, restored; all **killed by tests**):
codec accepts `00…` hex; codec folds case; `denominates` not checked; standard
code allowed as pinned; rail-scoped asset pinned; network dropped from
submission; settlement ignores network; settlement ignores issuer; Andrew guard
accepts Mainnet issuer; accepts any issuer; adapter serves `xrpl:`; recording
transport claims `validated`; recording transport accepts every submission
(14 mutations; two initially compile-killed were re-expressed to compile and
were then killed by tests).

## 13. Qualification Results

All runs after a forced full rebuild (`tsc -b --force`) on this branch.

| check | result |
| --- | --- |
| build / typecheck | pass / pass |
| lint (node16 imports, architecture, public surface) | pass |
| new P0-07 suites | **56 / 56** (33 + 11 + 12) |
| P0-06 suites (with the declared-`network` update) | 89 / 89 |
| focused regression — 320 files: every test matching destination, xrpl, andrew, no-bypass, structural, execution, grant, adapter, generic-http, core04, host, trusted, policy, exercise, registry, ctrl04, assure, prod02, approval, evidence, outcome, operator | **4,506 / 4,507** |
| the one failure | `structural-boundaries` R004.B — inherited CRLF artefact (§14) |
| `destination-approval` / `destination-registry` in that run | green |
| mutation testing | 14 / 14 killed by tests |
| secret / endpoint scan of the diff | only negative-test fixtures (`ledger.example`, refused) and the loopback listener |
| `git diff --check`, conflict markers | clean |

**Verdict.** P0-07 is clean. Governed USD is represented as Testnet RLUSD with
the exact value and no FX; destinations are Testnet-scoped; the demo Host runs
both scenarios to the transport; nothing was submitted to any ledger.

## 14. Inherited Issues (not P0-07)

- **SQLite WAL `SQLITE_BUSY` on concurrent first opening** — separate technical
  debt, not fixed here (P0-06 §26a). Same unguarded `PRAGMA journal_mode = WAL`
  in 27 stores; observed in `destination-approval` (P0-03) and, after the
  synchronization, `destination-registry` (P0-02) "parallel writers opening a
  brand-new file" (one hang in isolation, then green; untouched by the merge).
  Not on the demo's path: the composition opens each store once, sequentially.
- **CRLF**: `structural-boundaries` R004.B fails on this `core.autocrlf=true`
  checkout only (LF in the index).
- **Load-sensitive timeouts**: the authority-state witness 2 s bound can expire
  under very high test parallelism; runs here use `--test-concurrency=6`.

## 15. Files Changed

| file | change |
| --- | --- |
| `src/enterprise/execution-adapters/xrpl/xrpl-codec.ts` | 160-bit currency codes |
| `src/enterprise/execution-adapters/xrpl/contracts.ts` | `pinned` representation, `network` option and submission field, `XrplLedgerEvidence`, `XRPL_NETWORK_INVALID` |
| `src/enterprise/execution-adapters/xrpl/configuration.ts` | pinned validation, network label |
| `src/enterprise/execution-adapters/xrpl/payment-translation.ts` | comment (pinned shares the issued path) |
| `src/enterprise/execution-adapters/xrpl/xrpl-execution-adapter.ts` | network on submission |
| `src/enterprise/execution-adapters/xrpl/settlement.ts` | new — settlement profile and check |
| `src/enterprise/execution-adapters/xrpl/index.ts` | exports |
| `src/enterprise/andrew-demo/*` | new — settlement, recording transport, composition, barrel |
| `src/enterprise/__tests__/andrew-p007-*.test.ts` | new — 3 files |
| `src/enterprise/__tests__/xrpl-execution-adapter*.test.ts` | updated for the declared `network` and `settlement.ts` |
| `src/enterprise/__tests__/no-bypass-effect-paths.test.ts` | holder inventory |
| `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` | §7.1 row |
| `docs/demo/andrew/ANDREW-P0-06-XRPL-ADAPTER.md` | "P0-05 USD threshold" correction |
| `docs/demo/andrew/ANDREW-P0-07-TESTNET-RLUSD-COMPOSITION.md` | new — this document |

## 16. Readiness for P0-08

Ready for a real Testnet transaction **once P0-08 supplies the transport** in
§9; nothing in the adapter, governance or composition needs to change. Before
the first real submission: a funded Testnet treasury account with an RLUSD
trust line and Testnet RLUSD from the faucet; a real Testnet recipient
(funded for reserve, with an RLUSD trust line, registered as
`xrpl.testnet:r…` and initially **not** approved); the transport (§9) with its
endpoint and key held outside the repository; the delivered-amount check; the
EP inventory entry; and a decision on the XRPL client dependency (`xrpl.js`
pulls `ws`) and where it lives.
