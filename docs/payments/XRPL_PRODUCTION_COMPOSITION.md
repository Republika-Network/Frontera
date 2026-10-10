# XRPL Production Composition (PAY-03)

> **The shipped Frontera Host composes and operates the PAY-02 XRPL / RLUSD
> rail from explicit configuration — requesting signatures from an external,
> customer-controlled signer it never holds a key for, keeping a durable
> interlock so that no restart, second process or restore can let a payment
> compete with an earlier still-live transaction, and resolving unconfirmed
> payments from the ledger through the existing P12 flow.**

- Status: implemented in `src/enterprise/xrpl-payment-rail/` (composition edge) and
  `src/features/payment-runtime/rails/xrpl/` (rail; interlock port, restart quarantine, pinned-key check)
- Decision record: `docs/architecture/ADR-XRPL-PRODUCTION-COMPOSITION.md`
- Rail: `docs/payments/XRPL_RLUSD_RAIL.md` (PAY-02) · Contract: `docs/payments/PAYMENT_ADAPTER_CONTRACT.md` (PAY-01, unchanged)
- Effect path: EP-069 in `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md` (no new effect path)

PAY-03 is not a new payment model, not a second rail and not an XRPL feature
expansion. It is the production composition of the rail PAY-02 delivered.

## 1. Production path

```
PaymentIntent ─ PAY-01 compile ─ Governed Action
  ─ policy / authority / P10 limits / approvals ─ GRANT ─ P7 reservation ─ write-ahead claim
  ─ P12 binding: the XRPL resolution authority (before the claim)
  ─ PAY-01 bridge ─ PAY-02 rail
       build → connect + network_id → restart quarantine → validated index → autofill → fee ceiling
       → interlock pre-check → EXTERNAL SIGNER (HTTP) → verify blob (same tx, pinned key, own hash)
       → DURABLE RESERVATION → submit ONCE → finality
       → interlock settle | markUnconfirmed
  ─ P11 (validated result or unconfirmed + hash)
  ─ P12: explicit reconcile → XRPL resolution authority (read-only ledger lookup) → resolution
```

Two invariants:

- **Custody.** Frontera may *request* a signature. It never holds, reads or
  derives the customer's XRPL private key (§3).
- **Ambiguity.** A process restart, a second process or a restore never erases
  the knowledge needed to keep a second payment from competing with an earlier,
  still-live unconfirmed transaction (§6–§9).

## 2. Host composition

No `xrplPaymentRail` in the governed-action file → no XRPL rail, no signer, no
interlock file, no resolver, no XRPL module; the XRPL SDK is not even loaded
(`await import(…)` only when configured). The Host is unchanged.

With `xrplPaymentRail`, `bootEnterpriseHost` (before `createEnterprise`):

| step | does | on failure |
| --- | --- | --- |
| 1 | refuses if the process environment carries XRPL key material or the reference signer's configuration (`*XRPL*SEED/SECRET/PRIVATE/MNEMONIC/WALLET*`, `FRONTERA_REFERENCE_XRPL_SIGNER_*`) — presence only, never read | `HOST_ENVIRONMENT_INVALID` |
| 2 | opens the durable interlock and verifies every record | `XRPL_INTERLOCK_UNAVAILABLE` (refuse) |
| 3 | proves the external signer's identity against the pins | mismatch → `XRPL_SIGNER_IDENTITY_MISMATCH` (refuse); unreachable → start **degraded** |
| 4 | builds two SDK clients (rail; read-only resolver) | — |
| 5 | composes the PAY-02 rail with the interlock; `readiness()` connects, checks `network_id`, starts the restart quarantine clock | network mismatch → `XRPL_NETWORK_MISMATCH` (refuse); unreachable → **degraded** |
| 6 | wraps it in PAY-01's `createPaymentRailExecutionAdapter` and adds it to the **existing** execution-adapter registry, reachable only by its configured route | — |
| 7 | composes P12 with the XRPL resolution authority (plus operator attestation when operators are configured) | — |

Configuration invalid → refuse. A dependency merely unavailable (signer,
XRPL server) → start degraded and refuse payments with nothing signed or
submitted until it answers. There is no second governed path, no admin
endpoint that reaches the rail, and no package export.

## 3. Custody model

```
Frontera Host process                                    customer-controlled custody (separate process / service)
─────────────────────                                    ───────────────────────────────────────────────────────
holds: signer endpoint, transport credential,            holds: the XRPL key (HSM, KMS-backed service, or — for
       PUBLIC pins (signer id, signing public keys)             qualification only — the reference software signer)
rail ── prepared Payment ── POST /v1/sign/xrpl-payment ──▶ signs exactly that Payment, for its account
     ◀── { signedTransaction, hash } ─────────────────────  never submits, never decides
     verifies: decode(blob) signs exactly the prepared payment; SigningPubKey = pinned key;
               signature verifies under it; hash = hashSignedTx(blob)  — then submits once
```

The Host process never has: a seed, mnemonic, private key, wallet, or
`Wallet` object (structural test: `pay03-xrpl-production-structure`). Secrets
it does hold: the signer **transport** credential (bearer token, named by
environment variable, never inline). Neither it nor any key appears in a
payment intent, governed action, grant, execution request, P11, P12, trace,
evidence, logs, health, readiness, config-check output or backup (canary tests).

## 4. Signer protocol — `frontera.external-xrpl-transaction-signer.v1`

```
GET  /v1/identity           → { protocol, signerId, operations: ['sign-xrpl-payment'], accounts: [{ address, signingPublicKey }] }
POST /v1/sign/xrpl-payment  ← { protocol, signerId, requestId, account, transaction }
                            → { protocol, signerId, requestId, account, signedTransaction, hash }
```

- **One operation.** There is no generic byte signing, no "sign any XRPL
  transaction", no key export and no submission. `transaction` is exactly the
  PAY-02 prepared `Payment` (`TransactionType`, `Account`, `Destination`,
  `DestinationTag?`, issued-currency `Amount`, `Flags: 0`,
  `LastLedgerSequence`, `Sequence`, `Fee`) — `parsePreparedXrplPayment`
  refuses anything else, server side, before the key is touched.
- **Binding.** `requestId` is 32 fresh random bytes per call; the response must
  echo it, the pinned `signerId` and the requested `account`.
- **Closed both ways.** Exact plain-JSON records; an unknown, missing or extra
  field is refused.
- **Trust nothing that answered 200.** The rail independently verifies the blob
  (§3) before submitting.
- The signer **decides nothing**: governance happened before the payment was
  prepared.

## 5. Identity pinning and transport

**Pinning (no TOFU).** Trusted configuration pins `signer.signerId` and, per
source account, `signingPublicKey` (the 33-byte key, `ED…` or `02…`/`03…`).
The identity answer must match exactly; advertised identity is only compared,
never adopted. A mismatch — at startup or on any later handshake — refuses
signing for the life of the process. Rotation is configuration + restart.

**Transport** (`signer-http-transport.ts`, modelled on CORE-02's): one base URL
(https, or http to loopback only; no userinfo, query, fragment, path); TLS via
Node's default verification; bearer credential ≥ 32 characters in the
`authorization` header only; per-call budget `signer.timeoutMs` (default
10 000, 1 … 60 000); response ≤ 64 KiB; redirects never followed; refusal
bodies never parsed; **one attempt** — a retried signing request would be a
second signature over the same sequence. A signer timeout or failure **before
a usable signed blob** is `not-completed` with nothing submitted — never an
XRPL `unconfirmed`.

## 6. The durable submission interlock

`sqlite-xrpl-submission-interlock.ts` — one SQLite file
(`AOC_ENTERPRISE_XRPL_INTERLOCK_SQLITE_PATH`, default
`.data/xrpl-submission-interlock.sqlite`), bound at creation to one rail id and
XRPL `network_id`. One row per execution that ever **signed** a Payment:
account, `Sequence`, `LastLedgerSequence`, first possible ledger, transaction
hash, amount (currency, issuer, value), state, settlement.

Its one question: *is there an earlier submitted-but-unsettled payment from
this source account whose sequence window can still affect a new one?*

**Blocking rule** — a record blocks candidate sequence S on its account iff

```
record.state ≠ settled  and  record.LastLedgerSequence > validated ledger index  and  record.Sequence ≥ S
```

Every release is a **ledger fact**: once the validated ledger reaches
`LastLedgerSequence` the transaction can never be included; once it is in a
validated ledger (success or `tec`) the account sequence has moved past it, so
autofill answers a higher one. A restart, a timeout, a network outage or an
operator's wish releases nothing.

**Integrity.** Identity and state digests per row; SQL triggers refuse
`DELETE`, identity rewrites and backward state moves; an append-only
transition log must account for every row and every state (a row removed
behind the triggers is detected: `record-missing`). Every blocking read
verifies every record of the account whose window is still open — in any
state, so a row forged to look settled is verified, not trusted. Anything
that fails is `XRPL_INTERLOCK_CORRUPT`: the rail refuses before signing.
Schema version guarded before any `CREATE`; a file bound to another rail or
network is refused unmutated.

## 7. State model and write order

```
            reserve (BEGIN IMMEDIATE: one record per execution; blocking rule)
(none) ───────────────────────────────────────────▶ submitting
submitting ── submit answered, outcome unknown ───▶ unconfirmed
submitting ── validated success / tec / tem / expired / not-attempted ──▶ settled(settlement)
unconfirmed ── ledger fact (rail finality, or the P12 resolver) ─────────▶ settled(settlement)
```

Per execution, strictly: `recorded?` (an execution already held is never
prepared, signed or submitted again; reported `unconfirmed` with its hash) →
prepare → interlock pre-check (before spending a signature) → sign → verify →
**reserve (durable)** → submit once → settle | markUnconfirmed.

## 8. Crash safety (C1–C10)

| case | durable state | may another payment proceed? |
| --- | --- | --- |
| C1 crash before signing | none | yes — nothing was signed or submitted |
| C2 crash after signing, before the reservation | none | yes — the blob never left the process (submission happens only after `reserve` commits); the same sequence may be signed again |
| C3 crash after the reservation, before submit | `submitting` | not with a competing sequence until the ledger reaches `LastLedgerSequence` — a **bounded** false block (≤ `lastLedgerOffset` ledgers), never a false release |
| C4 crash during submit | `submitting` / `unconfirmed` | blocked until the ledger settles it or closes its window |
| C5 crash after submit, before the outcome write | `submitting` | blocked exactly like `unconfirmed` |
| C6 restart after unconfirmed | `unconfirmed` | blocked (record + restart quarantine) |
| C7 restart after completed | `settled` | yes, after the restart quarantine |
| C8 restart after a definitive failure | `settled` | yes, after the restart quarantine |
| C9 restore from a backup holding an unresolved submission | `unconfirmed` (restored) | blocked — restore clears nothing |
| C10 two processes race one account | one `reserve` wins inside `BEGIN IMMEDIATE`; the other is `blocked` | the loser is refused before submission |

All qualified in `pay03-xrpl-interlock.test.ts` (and C9 in `pay03-xrpl-host.test.ts`).

## 9. Restart, cross-process, rollback and freshness

**Restart quarantine.** When composed with the durable interlock, the rail
prepares nothing until the validated ledger has advanced
`lastLedgerOffset + 4` ledgers past the first validated index this process
observed (the Host reads it at boot). Any transaction an earlier process
submitted had `LastLedgerSequence ≤` its validated index + offset `≤` this
process's first index + offset — so once the quarantine passes, none can
still be included, **whatever the local file says**. The ledger is its own
freshness witness. Cost: XRPL payments are refused
(`xrpl-restart-quarantine`) for roughly `(offset + 4) × ~4 s` after each start
(≈ 30 s at the minimum offset 4, ≈ 1.5 min at the default 20).

**Cross-process.** Supported concurrency model: any number of Host processes
on **one shared state** (one SQLite file on one host). `reserve` is a single
`BEGIN IMMEDIATE` check-and-insert, so a second process cannot bypass an open
record; the per-process queue still serializes within a process. Distributed
locking across machines is **not** provided; Frontera's deployment model
remains one Host per state volume (`docs/deployment/PILOT_DEPLOYMENT.md`).

**Rollback / stale restore (assessed).** The interlock is **not** CORE-07
witness-anchored, and does not claim to be. A stale restore that loses an open
record cannot reopen sequence reuse: the restart quarantine above covers every
transaction submitted before the restored process started. Residual: if
`lastLedgerOffset` is *lowered* in the same change as a rollback that loses a
record whose window used the larger offset, the quarantine is shorter than
that window. Do not lower the offset across a restore; raise it freely.

## 10. P12 XRPL resolution authority

`createXrplResolutionAuthority` — `authorityId: frontera.xrpl-rlusd-ledger`,
bound before the claim to every execution of the rail's `paymentAction`
(other actions bind to operator attestation when operators are configured).

| ledger fact (lookup of the recorded hash over `[firstLedger, LastLedgerSequence]`) | answer |
| --- | --- |
| validated `tesSUCCESS`, `delivered_amount` exactly the recorded amount, currency, issuer | `confirmed-completed`, ref = hash |
| validated `tec…` | `confirmed-not-completed PROVIDER_REJECTED` |
| `txnNotFound`, `searched_all`, validated index ≥ `LastLedgerSequence` | `confirmed-not-completed PROVIDER_REJECTED` (expired) |
| pending; incomplete history; network failure / mismatch; malformed answer; delivered ≠ recorded; wrong issuer / currency; unrecognized result | `unresolved` |
| no interlock record, or one that disagrees with the P11 attempt (hash, asset, amount) | `unresolved` |

- **Read-only.** Its ledger capability is a frozen object with `connect`,
  `serverInfo`, `validatedLedgerIndex`, `lookupTransaction` — no `submit`, no
  `autofill`, no signer, a separate connection (structural + runtime tests).
- **Absence is never evidence.** A missing record would prove "never
  submitted" only if the file could not have been rolled back, so the
  resolver never answers from absence. An execution that crashed before its
  reservation (C1/C2) therefore stays P12-`unresolved`, its P7 capacity
  conservatively consumed (§13).
- **P12 unchanged.** One binding per execution, one resolution, no timer, no
  background job; only an explicit `reconcile` asks it, at most once. An
  operator cannot attest over an XRPL-bound execution (`authority-mismatch`):
  provider truth from the ledger is the authority there.

### Resolution and the interlock

After a definitive answer the resolver records the same ledger fact on the
interlock (`settle`) — bookkeeping. The interlock's blocking rule already
released on that fact (the sequence moved past it, or the window closed), so
the P12 record and the interlock cannot diverge into an unsafe state: if the
`settle` write fails, the record merely stays open until the ledger closes its
window; if the P12 append fails, the interlock is unaffected. An `unresolved`
answer changes nothing.

## 11. Configuration (`governed-actions.json` → `xrplPaymentRail`)

| field | class | rule |
| --- | --- | --- |
| `paymentAction` | REQUIRED | routed (in `routes`) to the rail's adapter id and nothing else; listed in `monetary.financialActions` |
| `network`, `allowMainnet`, `endpoint`, `asset`, `lastLedgerOffset`, `maxFeeDrops`, `requestTimeoutMs`, `finalityTimeoutMs`, `pollIntervalMs` | as PAY-02 | validated by `createXrplRlusdRailConfiguration` — mainnet needs **both** `network: "mainnet"` **and** `allowMainnet: true`; no default selects mainnet; `asset.paymentAsset` declared in `monetary.assets` |
| `sourceAccounts[]` | REQUIRED | `{ accountId, address, signingPublicKey }` |
| `signer.endpoint` | REQUIRED | https, or http to loopback |
| `signer.signerId` | REQUIRED | the pinned signer identity |
| `signer.credential` | REQUIRED | `{ kind: "bearer", tokenEnv: "<VAR>" }`; inline secrets refused |
| `signer.timeoutMs` | OPTIONAL (10 000) | 1 … 60 000 |

Closed at every level (`seed`, `secret`, a typo — refused). Requires
`AOC_ENTERPRISE_PERSISTENCE_PROVIDER=sqlite` (`HOST_PERSISTENCE_NOT_DURABLE`
otherwise). **Config check** (`npm run check:host-configuration`, the pilot's
`config-check`) runs the same validation — contacting nothing — and requires
the interlock store's storage. Example: `examples/payments/governed-actions.xrpl-testnet.example.json`.

## 12. Readiness, health, shutdown, backup

- **Modules** (the existing health model; no new endpoint):
  `aoc.enterprise.xrpl-submission-interlock` — **required**; unhealthy when
  the file is unreadable or fails integrity (an open record is counted,
  `openSubmissions`, never unhealthy). `aoc.enterprise.xrpl-payment-rail` —
  **optional**; healthy when the signer identity is proven and the ledger
  answers on the right network, degraded while either is unavailable,
  unhealthy on identity or network mismatch. Details carry closed states and
  the signer id only — no endpoint, address, credential or key.
- **Shutdown** closes the rail's client, the resolver's client and the
  interlock — and clears nothing.
- **Backup / restore.** `xrpl-submission-interlock` is in the PROD-02 store
  registry (condition `xrpl-payment-rail`; P12's `embedder-reconciliation`
  now also holds when the rail is configured). `backup:v1` copies it,
  `restore:v1` deep-verifies it under its own recorded scope, and an
  unresolved submission is restored unresolved. The signer credential is a
  named secret reference (never a value); the reference signer's key file is
  excluded durable state.

## 13. Deployment

The pilot kit stays rail-neutral: `governed-actions.example.json` carries no
`xrplPaymentRail`, and D14 / O15 assert it. The compose file lists the
interlock's store **location** with every other store (a location composes
nothing). The opt-in example `examples/payments/governed-actions.xrpl-testnet.example.json`
(Testnet only, outside the rail-neutral kit) shows the section.

**The kit does not include a signer.** The external signer is the customer's
custody service; it must implement §4, bind to an address the Host alone can
reach, and hold its key where the Host cannot read it (separate process,
container and secret injection). The **reference** signer
(`npm run start:reference-xrpl-signer`, `scripts/run-reference-xrpl-signer.mjs`)
is for development and Testnet qualification only: one key in a mode-0600 file
of its own, loopback HTTP, explicitly **not** an HSM and **not** a custody
recommendation. The Host refuses to start with any `FRONTERA_REFERENCE_XRPL_SIGNER_*`
variable in its own environment.

**Runtime image.** `xrpl@5.3.0` is a runtime dependency (exact pin), so
`npm ci --omit=dev` — the Dockerfile's production install — contains the SDK
(qualified by `scripts/payments/qualify-xrpl-production-artifact.mjs`).

## 14. Limitations

Not provided: a production custody service (HSM / KMS integration is the
customer's signer); mTLS or workload identity on the signer transport (a
further `ExternalXrplSignerTransport`); multi-signing; distributed locking
across machines; CORE-07 anchoring of the interlock (bounded by the restart
quarantine instead, §9); P12 resolution of an execution that crashed before
its durable reservation (stays `unresolved`, capacity consumed; it provably
submitted nothing, but absence is not used as evidence); resolution when the
configured server lacks the history (`searched_all: false` → `unresolved`; use
a full-history server or Clio for resolution); availability during the
restart quarantine; automatic retry or resubmission of anything — ever;
mainnet qualification; Lightning, x402, AMM, DEX, TrustSet automation, routing.
