# ANDREW-P0-08 — Real XRPL Testnet Transport

| | |
| --- | --- |
| Task | ANDREW-P0-08 — the first task allowed to submit real transactions to XRPL **Testnet** (never Mainnet) |
| Branch | `feat/andrew-p0-08-real-xrpl-testnet-transport` |
| Baseline | `d76db3fc97898d14a5f1829d8cc29cb2a9959abd` (`feat/andrew-demo`, P0-00 … P0-07 + `origin/main` `e3383b7`) |
| Status | Transport implemented and qualified offline (§12); Testnet accounts provisioned; **live USD 75,000 transfer BLOCKED on Testnet RLUSD funding** (§10) |

> **No governed payment was submitted.** The only real Testnet transactions in
> P0-08 are the two account-setup `TrustSet`s (§9). The live governed run was
> executed up to its preflight, which refused — correctly — because the treasury
> holds 0 of the 75,000 Testnet RLUSD required. Nothing was signed or submitted
> for the governed action, and the amount was not reduced.

## 1. Objective

Frontera authorization → signed grant → real XRPL Testnet transport → real
RLUSD Payment → validated transaction → hash → validated ledger evidence →
durable Frontera outcome.

## 2. Phase 0 — Baseline

| check | result |
| --- | --- |
| `feat/andrew-demo` | `d76db3f`, clean, contains P0-07 `2546e19` and `origin/main` |
| `origin/main` (fetched) | `e3383b70e7e9c1eac058381652bceb9f99927c88` (unchanged) |
| P0-07 Scenario A/B + XRPL adapter suites | **145 / 145** |
| unapproved USD 75,000 | 0 grants, 0 transport calls |
| approved USD 75,000 | 1 grant, exactly 1 instruction `{"TransactionType":"Payment",…,"Amount":{"currency":"524C555344000000000000000000000000000000","issuer":"rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV","value":"75000"}}` |
| USD 125,000 vs USD 100,000 | 0 grants, 0 transport calls |

## 3. Phase 1 — Testnet Constants (verified 2026-10-04)

| constant | value | source |
| --- | --- | --- |
| Testnet WebSocket | `wss://s.altnet.rippletest.net:51233/` | xrpl.org *XRP Faucets* |
| Testnet JSON-RPC | `https://s.altnet.rippletest.net:51234/` | same |
| network id | Testnet **1** (Mainnet 0, Devnet 2); `NetworkID` **omitted** for ids ≤ 1024 | xrpl.org *Transaction Common Fields* |
| RLUSD currency / Testnet issuer | `524C555344000000000000000000000000000000` / `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` | Ripple *RLUSD on the XRP Ledger* (P0-07) |
| `LastLedgerSequence` | last validated ledger **+ 4** for automated processes | xrpl.org *Reliable Transaction Submission* |

Live check at connection: the server reported `network_id: 1` (validated
ledgers 21285929 … 21286040 during this task). The endpoint always comes from
runtime configuration (`FRONTERA_XRPL_TESTNET_ENDPOINT`); a missing, Mainnet,
contradictory or absent `network_id` refuses before anything is prepared.

## 4. Phase 2 — The Isolated XRPL Client

`packages/xrpl-testnet-transport` (`@aoc-enterprise/xrpl-testnet-transport`) —
a leaf workspace package on the `pinata-adapter` precedent. `xrpl@4.7.0` is
declared **only** there; the root manifest and root lockfile entry declare no
`xrpl`, `ws` or `ripple-*` (tests). It imports nothing from the runtime; the
runtime's production code imports nothing from it (the composition receives
the transport injected; only tests and the live runner name both).

```
governed execution → P0-06 XRPL adapter → XrplPaymentTransport
  → P0-08 transport (packages/xrpl-testnet-transport) → xrpl.js → XRPL Testnet
```

The adapter (`src/enterprise/execution-adapters/xrpl/`) stays network-free:
no `xrpl`, WebSocket, `Client`, `Wallet`, endpoint or signing code (tests).
EP-069 is the new egress (§11). The P0-07 recording transport remains for
offline tests.

| file | role |
| --- | --- |
| `contracts.ts` | submission/observation shapes (structurally identical to the adapter's), signer and ledger-client boundaries |
| `testnet-configuration.ts` | Testnet-only configuration: `wss://` only, Mainnet hosts refused, network id 1, horizon 4, minimum grant remaining 120 s, max fee 5,000 drops, validation wait 120 s |
| `env-signer.ts` | the demo signer (seed from the environment) |
| `attempt-store.ts` | durable, append-only submission attempts |
| `xrpl-testnet-transport.ts` | the transport |
| `decimal.ts` | exact issued-value comparison |
| `xrpl-ledger-client.ts` | the one submitting XRPL connection (EP-069) |
| `preflight.ts`, `xrpl-preflight-reader.ts` | read-only preflight |
| `scripts/provision-testnet-accounts.mjs`, `scripts/preflight.mjs` | Testnet setup and preflight |

## 5. Phase 3 — Signer Boundary

```ts
interface XrplTransactionSigner {
  readonly account: string;                                   // public
  sign(prepared): Promise<{ txBlob: string; hash: string }>;  // nothing else
}
```

The transport prepares; the signer signs exactly that. The transport then
**decodes the returned blob** and checks every field against what it prepared,
and **re-hashes** the blob (`hashSignedTx`) against the returned hash — a signer
that alters the transaction or misreports the hash is refused before
persistence or submission. `createEnvXrplSigner` reads the seed once from a
named variable, keeps the wallet in a closure, refuses a seed for any other
account, exposes only `{ account, sign }`, and raises fixed phrases only.
Replaceable by KMS/HSM/hardware signing with the same two members. Seeds live
only in `~/.config/frontera-andrew/testnet.env` (directory 0700, file 0600),
outside every repository; never printed, logged, committed, stored in evidence
or returned.

## 6. Phase 4 — Durable Submission Attempt

Audit: the P10/P11 execution-outcome store prepares a durable attempt keyed by
`executionId` before the adapter and records the terminal outcome after, but
adapters and transports are structurally barred from it and it owns no ledger
facts. So a **transport-local** store holds what reliable submission needs,
keyed by the same `executionId` — the two join on `executionId` and the hash.

Persisted **before** submit, atomically (`BEGIN IMMEDIATE`, `synchronous=FULL`):
`executionId, requestId, decisionId, network, source account, destination,
currency, issuer, value, fee, Sequence, LastLedgerSequence, transaction hash,
signed blob, validated ledger at prepare, notAfter, createdAt` + event `signed`.
Rows and events are append-only (UPDATE/DELETE refused by triggers); one
attempt per `executionId` (primary key) and per hash (unique) — **the database
refuses a second signature's attempt**. The blob is replay-sensitive: never
logged, never returned by `find`, readable only through `signedBlob` for manual
reconciliation.

Order: prepare → sign → verify → **persist** → submit. A persist failure means
no submit. An existing attempt is reconciled by its hash — never re-signed,
never resubmitted. A throw during submit is `submit-uncertain`; a wait without
a final answer is `unresolved` (`unconfirmed`). No automatic second submission.

## 7. Phases 5–6 — Prepare and Settle

The adapter supplies Destination, Amount, network label, `notAfter` and
correlation; the transport supplies `Account` (configured treasury), `Fee`,
`Sequence` (autofill) and `LastLedgerSequence` = validated + 4 (overriding
autofill's +20). Before signing it refuses: any field outside {TransactionType,
Account, Destination, Amount, Fee, Sequence, LastLedgerSequence, Flags=0,
SigningPubKey} (so no `NetworkID`, `SendMax`, `Paths`, `Memos`,
`DestinationTag`, partial-payment flag); a changed account, destination or
amount; a fee above 5,000 drops. The P0-07 settlement check
(`checkXrplSettlement` + the Andrew profile) runs **first**, before any network
call: network label `xrpl-testnet`, RLUSD currency, Testnet issuer. Local
checks refuse an XRP amount, an invalid destination, the treasury paying itself
and the issuer as source. Destination namespace `xrpl.testnet` and the exact
governed value are enforced upstream (grant + adapter, P0-06/P0-07) and the
transport re-checks the value it signs equals the instruction's.

**Grant horizon.** `LastLedgerSequence` is a ledger-index expiry, not a clock.
So the transport refuses to sign with less than 120 s of grant lifetime left,
carries `notAfter` into the attempt, and after validation compares the
including ledger's close time with `notAfter`: a payment validated after the
authorized horizon is an **anomaly** — never "governance-compliant", never
retried, routed to reconciliation.

## 8. Phase 9 — Validated Outcome

Completion requires a validated ledger and: `TransactionResult == tesSUCCESS`;
the looked-up hash equals the persisted hash; Account and Destination equal the
attempt; `DeliverMax`/`Amount` and `meta.delivered_amount` equal the pinned
RLUSD currency and Testnet issuer with exactly the authorized value (canonical
decimal comparison — `"7.5e4"` = `"75000"`, `"74999.99"` ≠; never a float); a
close time inside the grant horizon. Anything missing, malformed or different
is an **anomaly** (`unconfirmed`, manual reconciliation) — never completion,
never a retryable failure. `tec…` validated → `rejected` (payment failed, fee
charged). `LastLedgerSequence` passed with every ledger searched → `rejected`
(expired). `ter…`, timeouts, exceptions → no new transaction.

Defence in depth in the adapter: a `validated` observation whose reported
delivered amount differs from the instruction is `unconfirmed`, not
`completed`.

## 9. Phase 7 — Testnet Accounts and Preflight

Created by `provision-testnet-accounts.mjs` (approved by the project owner),
funded with Test XRP by the official Testnet faucet:

| account | address | setup transaction (validated `tesSUCCESS`) |
| --- | --- | --- |
| TREASURY | `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` | RLUSD `TrustSet` `1724C6914FEC148186BE4E67EB8FFE7E0D1E8677B18BB292DE0F0489F040C253` (ledger 21285934) |
| RECIPIENT | `rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` | RLUSD `TrustSet` `C085D086F595CAE87C868D689A6DAEEC016C654811407D034DEAED7198AC5162` (ledger 21285936) |

Both trust lines: limit 1,000,000, `tfSetNoRipple` (Ripple's documented flag).
The recipient is real, funded, trust-lined — technically able to receive RLUSD —
and is **not** approved in Frontera. A trust line is a ledger fact, never a
Frontera approval.

Preflight (read-only; `scripts/preflight.mjs`, latest run):

| fact | value |
| --- | --- |
| connected network | `network_id` 1 (XRPL Testnet) |
| latest validated ledger | 21286040 |
| treasury XRP | 99.999988 XRP — ready |
| treasury RLUSD trust line | present |
| **treasury RLUSD balance** | **0** — **75,000 required** |
| recipient XRP | 99.999988 XRP — ready |
| recipient RLUSD trust line | present (limit 1,000,000 ≥ 75,000) |
| recipient Frontera registration / approval | registered as `xrpl.testnet:rhScSFhnm7kAZFZzkPj1aVXw6vWxSc424z` and `never-approved` at the start of every run (the live runner registers it in a fresh Host) |
| verdict | **not ready** — "the treasury holds 0 RLUSD; 75000 is required — fund it from the Testnet RLUSD faucet" |

## 10. Phase 8 — Live Andrew Scenario: BLOCKED (external)

The live runner (`src/enterprise/__tests__/andrew-p008-live-testnet.test.ts`,
gated by `FRONTERA_ANDREW_LIVE_TESTNET=1`) was executed against XRPL Testnet.
It stopped at its preflight: *"preflight is not green — no governed request was
made: the treasury holds 0 RLUSD; 75000 is required"*. No governed request, no
signature, no submission; no attempt store was created.

**Exact funding remaining:** 75,000 Testnet RLUSD to
`rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` (trust line already set), from Ripple's
Testnet RLUSD faucet (tryrlusd.com — a browser faucet; per-claim amounts are not
documented, so several claims may be needed). Then run:

```bash
set -a; . ~/.config/frontera-andrew/testnet.env; set +a
node packages/xrpl-testnet-transport/scripts/preflight.mjs         # must print "ready": true
FRONTERA_ANDREW_LIVE_TESTNET=1 \
FRONTERA_XRPL_TESTNET_ENDPOINT='wss://s.altnet.rippletest.net:51233/' \
FRONTERA_ANDREW_ATTEMPT_STORE=$HOME/.config/frontera-andrew/xrpl-attempts.sqlite \
FRONTERA_ANDREW_EVIDENCE_FILE=$HOME/.config/frontera-andrew/p008-evidence.json \
node --test dist/src/enterprise/__tests__/andrew-p008-live-testnet.test.js
```

The run performs, in order: preflight; registration; USD 75,000 while
`never-approved` → denied, 0 grants, 0 signatures, 0 submissions (with the
recipient's trust line recorded); approval as `organization-administrator`;
a fresh USD 75,000 → one grant, one signature, one submit, validated; an
independent re-read of the transaction; the ASSURE-01 trace; USD 125,000 →
withheld, no new signature or submission. It writes non-secret evidence JSON.
A second run fails closed at preflight once the treasury has paid.

## 11. Phase 10 — Durable Frontera Evidence (proven offline; live pending)

No parallel receipt system. The chain, joined on `executionId` and the hash:

| link | where |
| --- | --- |
| organization, principal/agent, governed action, USD amount, destination key, decision | ASSURE-01 trace (`GET /api/evidence/traces/{requestId}`) |
| destination approval evidence | P0-03 history: `approvedBy`, `authorityBasis` (`operator-permission:destination.approve;role:organization-administrator;credential:operator`), sequence |
| authority ceiling USD 100,000; grant | grant `scope.amount = { kind: 'ceiling', limit: '100000', unit: 'USD' }`, `scope.counterparty = xrpl.testnet:<recipient>` |
| `executionId`, adapter `xrpl-testnet.treasury`, outcome, **`providerRef` = XRPL hash** | P10/P11 outcome store, in the ASSURE-01 trace |
| validated ledger index, engine result, delivered RLUSD | transport attempt store, terminal event `validated-success` |

AUTHORITY UNIT: **USD 75000** (grant, ceiling, policy). RAIL REPRESENTATION:
**RLUSD 75000 on XRPL Testnet** (transport record only). The grant is never
rewritten as RLUSD (test). Proven end to end offline
(`andrew-p008-real-transport-host.test.ts`): the Host's `executed` result
carries the hash as `providerRef`, the trace contains the hash, adapter id and
`executionId`, and the attempt store holds `tesSUCCESS`, ledger index and
delivered `75000`.

### No-bypass

EP-069 (`| **EP-069** |`, PROVEN — PATH LOCAL, composition-gated) added to
`NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`; §7.6 names both XRPL connection
sites; counts move to **nine of sixty-nine** (as P6 moved them for EP-050), in
every current-state statement CORE-06 pins (no-bypass doc, `SECURITY_INVARIANTS.md`,
master plan, CORE-06 qualification doc). A new NB suite proves only the
transport package imports `xrpl`/`ws`/`ripple-*`, exactly two sources open an
XRPL connection, only the ledger client submits, and the transport signs and
submits from exactly one place each.

## 12. Tests

| suite | tests | covers |
| --- | --- | --- |
| `packages/xrpl-testnet-transport/__tests__/xrpl-testnet-transport.test.ts` | 38 | Mainnet/non-wss/credentialed endpoints, wrong label/id, issuer as source, foreign signer; network id 0/2/absent refused before prepare; settlement drift with zero network calls; XRP/invalid/self destination; grant lifetime; 10 prepared-field mutations; signer failure; tampering signer; lying hash; persistence failure; happy path with persist-before-submit, horizon +4, no `NetworkID`; duplicate `executionId`; restart reconciliation; submit throw; unvalidated wait; expiry with/without full search; `tec`; 10 anomaly cases; exact decimals; secrets absent from events/errors/observations/DB; env signer fixed phrases; preflight verdicts and shortfall wording |
| `andrew-p008-real-transport-host.test.ts` | 4 | the real transport in the composed Host (scripted ledger): unapproved → 0 connections/signatures; approved fresh → executed, 1 signature, 1 submit, hash = `providerRef`, trace carries it; **USD 125,000 → withheld, 0 connections, 0 signatures, 0 submits**; namespace-only change denied |
| `andrew-p008-structure.test.ts` | 15 | package imports nothing from the runtime; adapter and demo network-free; no runtime importer of the package; no committed seed/key/blob; scripts print no seed; adapter delivered-amount defence (9 cases) and exact decimals |
| `andrew-p008-live-testnet.test.ts` | live | gated; executed — failed closed at preflight (§10) |
| changed | — | `no-bypass-effect-paths.test.ts` (EP-069, nine of sixty-nine, XRPL sites), dependency rules in `xrpl-execution-adapter-structure.test.ts` and `andrew-p007-structure.test.ts` |

## 13. Qualification Results

After a forced full rebuild (`tsc -b --force`) on this branch:

| check | result |
| --- | --- |
| build / typecheck / lint | pass / pass / pass |
| transport package suite | **38 / 38** |
| P0-08 runtime suites | 4 / 4 (real transport in the Host) + 15 / 15 (structure) |
| focused regression — 332 files (P0-01 … P0-08, CTRL-04, ASSURE-01, PROD-02, no-bypass, approvals, evidence, outcome, resolution, reconciliation, receipt, operator) | **4,640 / 4,641** |
| the one failure | `structural-boundaries` R004.B — inherited CRLF artefact of this Windows checkout |
| mutation testing | **16 / 16 killed by tests**: settlement gate ignored; network id unchecked; existing attempt re-signed; grant lifetime guard removed; horizon widened to +20; `tec` as success; delivered amount unchecked; post-validation horizon unchecked; hash mismatch ignored; signed blob unverified; expiry without full search; submit throw as not-submitted; Mainnet endpoint allowed; extra prepared fields allowed; decimals compared as raw strings; adapter ignores delivered amount |
| live run | executed; **failed closed at preflight** (0 RLUSD) — no governed request, signature or submission |
| secret scan | no seed, private key or signed blob in any tracked file touched by P0-06 … P0-08 (test); seeds only in the 0600 file outside the repository |
| `git diff --check`, conflict markers | clean |

One regression found and fixed during qualification: P12's
`execution-reconciliation-boundaries` forbids any package surface named for
reconciliation; the transport's manual re-check method was renamed
`reconcile` → `recheck` (it only re-reads a persisted attempt by hash;
settling a Frontera outcome stays with P12 resolution).

**Verdict.** The P0-08 transport is complete and qualified offline, and the
live path is proven to fail closed. The live USD 75,000 Testnet transfer has
**not** happened; it is blocked solely on Testnet RLUSD funding (§10). Per the
task's stop condition, P0-08 is committed on its branch and **not** merged into
`feat/andrew-demo` until the live transfer validates.

## 14. Readiness for P0-09

Not yet: P0-09 (the complete governed flow, linked reconsideration) should
start from a `feat/andrew-demo` that contains a P0-08 whose live transfer has
validated. The code P0-09 builds on is ready.

## 15. Remaining Before the Live Transfer

1. 75,000 Testnet RLUSD on `rNh9VpjEbgPVs2a9LxW7dZ6ePAP1sRWMpF` (faucet).
2. Re-run the preflight (must be `"ready": true`), then the live runner (§10).
3. Record here the transaction hash, validated ledger index, engine result,
   delivered amount and the trace excerpt from the evidence JSON.
4. Commit that evidence, then merge P0-08 into `feat/andrew-demo` with `--no-ff`.
