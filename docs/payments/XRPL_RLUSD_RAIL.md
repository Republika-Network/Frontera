# XRPL / RLUSD Payment Rail (PAY-02)

> **A payment already governed and granted by Frontera, translated into one
> XRPL issued-currency `Payment`, submitted at most once, and mapped back onto
> the existing three-way execution outcome.**

- Status: implemented in `src/features/payment-runtime/rails/xrpl/`
- Decision record: `docs/architecture/ADR-XRPL-RLUSD-PAYMENT-RAIL.md`
- Contract it implements: `docs/payments/PAYMENT_ADAPTER_CONTRACT.md` (PAY-01, unchanged)
- Architecture: `docs/payments/PAYMENT_ARCHITECTURE.md`
- Effect path: EP-069 in `docs/security/NO_BYPASS_AUTHORITY_CONTROLLED_EXECUTION.md`

## 1. Architecture

The rail is **below** governance. Nothing in it decides whether a payment is
allowed; every one of those questions was settled before it is called.

```
PaymentIntent ─ validate ─ compile ─▶ GovernedActionIntent           (PAY-01)
   ─ orchestrator ─ Kernel ─ committed decision ─ (approval) ─ P10 ceiling
   ─ bounded grant ─ exercise ─ P7 reservation ─ write-ahead claim     (Frontera, unchanged)
   ─ createPaymentRailExecutionAdapter ─ PaymentExecutionRequest        (PAY-01 bridge)
   ─ XRPL / RLUSD rail                                                  (PAY-02)
        build → connect + network check → prepare → sign → verify → submit ONCE → finality
   ─ PaymentRailResult ─ ExecutionAdapterResult ─ P11 durable outcome ─ P12 if unconfirmed
```

There is no other way to reach it: `createXrplRlusdRail` returns a
`PaymentRail`, and the host composes it only through PAY-01's
`createPaymentRailExecutionAdapter` — as `authorityControlledExecution.executionAdapter`
or as a child of `executionAdapterRouting`, where trusted routing selects it.

| Frontera owns (unchanged) | The rail owns |
| --- | --- |
| identity, authority, policy, limits, approvals, emergency controls, grant, execution claim, outcome durability, P12, evidence, disclosure, operator visibility | XRPL destination parsing, RLUSD asset mapping, transaction construction, signing hand-off and verification, submission, finality reading, result normalization, transaction-hash capture |

## 2. Module layout

| file | owns | XRPL SDK |
| --- | --- | --- |
| `xrpl-config.ts` | trusted configuration, validation, network table | — |
| `xrpl-address.ts` | classic-address validation, destination kinds and parsing | `isValidClassicAddress` |
| `xrpl-amount.ts` | canonical decimal ↔ XRPL issued value, exactness bounds | — |
| `xrpl-payment-builder.ts` | `PaymentExecutionRequest` → XRPL `Payment` | — |
| `xrpl-client-port.ts` | `XrplClientPort`, `XrplTransactionSigner`, transaction types | — |
| `xrpl-codec.ts` | verifies a signed blob signs exactly the prepared payment | `decode`, `encodeForSigning`, `hashes` |
| `xrpl-result-normalizer.ts` | reads submit / tx / server answers, conservatively | — |
| `xrpl-rail-details.ts` | bounded `detail` tokens | — |
| `xrpl-rlusd-rail.ts` | `createXrplRlusdRail` — the execution sequence | — |
| `xrpl-sdk-client.ts` | `createXrplSdkClient` — the **one** connection and `submit` site (EP-069) | `Client` |
| `tests/` | fake client, test-only software signer, contract and boundary tests | test-only |

## 3. Rail identifier

`xrpl-rlusd` (`XRPL_RLUSD_RAIL_ID`). A semantic identifier under PAY-01's rail
grammar; recorded as the P11 `adapterId`; matched against a payment's
`rail` preference by the PAY-01 bridge (a payment granted for another rail
never reaches this one).

## 4. Configuration

`createXrplRlusdRailConfiguration(input)` validates and freezes it, or throws
`XrplRailConfigurationError` (`XRPL_RAIL_CONFIGURATION_INVALID`, with the
refused field path — never the value).

The input is an **exact, closed, data-only record** at every level (top
level, `asset`, each `sourceAccounts` entry): plain objects whose own
properties are all declared, string-keyed, enumerable data properties, and a
dense `sourceAccounts` list with no property but its indices and `length`.
An undeclared name (a typo such as `maxFeeDrop` is refused — it never leaves
the `maxFeeDrops` default in force), a symbol, a non-enumerable property, an
accessor (never run), an inherited field or a sparse list is refused. Each
property is read once, by descriptor; nothing is normalized.

| field | class | rule |
| --- | --- | --- |
| `network` | REQUIRED | `testnet` \| `devnet` \| `mainnet`. **No default.** |
| `allowMainnet` | REQUIRED for mainnet | `true` exactly when `network: 'mainnet'`; set on another network it is refused as contradictory |
| `endpoint` | REQUIRED | `wss://` only; no credentials, query or fragment; a known public host of a *different* network is refused |
| `asset.paymentAsset` | REQUIRED | the P9 asset id payments must be denominated in, compared exactly |
| `asset.currency` | REQUIRED | XRPL currency code — RLUSD is `524C555344000000000000000000000000000000` |
| `asset.issuer` | REQUIRED | issuer classic address **for the selected network**; never a source account |
| `sourceAccounts` | REQUIRED | `[{ accountId, address }]`, 1…64, unique on both sides |
| `lastLedgerOffset` | OPTIONAL (20) | 4…200 ledgers |
| `maxFeeDrops` | OPTIONAL (`'1000'`) | fee ceiling, whole drops as text, ≤ 1 000 000 |
| `requestTimeoutMs` | OPTIONAL (10 000) | per SDK request |
| `finalityTimeoutMs` | OPTIONAL (120 000) | total wall-clock budget for the post-submission finality phase (§13) |
| `pollIntervalMs` | OPTIONAL (4 000) | between lookups; shorter than the finality timeout |
| `networkId` | DERIVED | 0 mainnet · 1 testnet · 2 devnet |
| signer | **not configuration** | an `XrplTransactionSigner` capability per source account, composed separately |

There is **no SECRET field**. No seed, key, token or credential is ever rail
configuration, and the rail ships no endpoint and no issuer address — the
issuer is taken from Ripple's published RLUSD documentation for the selected
network and entered as trusted configuration.

### Network safety

Mainnet is never implicit:

1. `network` has no default — a configuration without one is refused;
2. `mainnet` requires a second explicit `allowMainnet: true`;
3. a known mainnet host under a `testnet`/`devnet` configuration (and vice
   versa) is refused at composition;
4. at connection time — `readiness()` and **before every preparation** — the
   server's `server_info.network_id` must equal the configured network's id.
   A mismatch (or no `network_id`) refuses the payment with nothing prepared,
   signed or submitted (`xrpl-network-mismatch`).

### Config check and Host composition

The rail is **not** Host-config composable in PAY-02: the pilot deployment kit
deliberately carries no XRPL configuration (PROD-03 D14), and the Host's
config check is unchanged. An embedder composes the rail in code and passes
the resulting adapter as `executionAdapters` / `executionAdapter`.
`createXrplRlusdRailConfiguration` is the pure config check: it needs no
network.

## 5. Source account mapping

`PaymentExecutionRequest.source.accountId` (the governed resource the grant
bound) → trusted `sourceAccounts` mapping → classic address. An unmapped
account is refused before anything is contacted (`xrpl-source-not-mapped`).
The request never carries an address, key or signer, and the issuer can never
be a source.

## 6. Destination format

PAY-01's `PaymentDestination { kind, reference }`, unchanged. The rail
accepts two kinds:

| kind | reference | governed counterparty |
| --- | --- | --- |
| `xrpl-account` | classic address | `xrpl-account:rXXXX…` |
| `xrpl-tagged-account` | `<classic address>:<destination tag>` | `xrpl-tagged-account:rXXXX…:4471` |

The classic address is validated with the SDK's checksum, bounded by the
classic alphabet and length first (whitespace, oversized and non-string
values never reach the codec). The destination tag is a canonical unsigned
32-bit decimal (`0`…`4294967295`, no sign, no leading zero).

**The destination tag is governed.** It is part of the counterparty the
Kernel decides on and the grant binds: a grant for `r…:1` is not a grant for
`r…:2` or for untagged `r…`. No PAY-01 change was needed — PAY-01's reference
grammar admits `:` and its counterparty encoding splits on the first `:`.

**Refused:** X-addresses (a second spelling of the same destination would let
a grant bound to one spelling be satisfied by another), any other kind, a
destination equal to the source, and the issuer (that is a redemption, not a
payment).

## 7. RLUSD asset mapping

PAY-01's asset stays the P9 asset id; the rail maps it, explicitly:

```
request.amount.unit === configuration.asset.paymentAsset   else  xrpl-asset-not-configured (nothing contacted)
Amount = { currency: configuration.asset.currency, issuer: configuration.asset.issuer, value: request.amount.value }
```

The issuer and currency come only from trusted configuration — never from
the request, the destination or the asset id's text.

## 8. Transaction construction

Exactly one transaction type, `Payment`:

| XRPL field | source |
| --- | --- |
| `TransactionType` | constant `Payment` |
| `Account` | source mapping |
| `Destination`, `DestinationTag` | the granted counterparty |
| `Amount` | `{ currency, issuer }` from configuration; `value` = the canonical decimal, unchanged |
| `Flags` | constant `0` — never `tfPartialPayment` |
| `LastLedgerSequence` | current validated ledger + `lastLedgerOffset` (trusted) |
| `Sequence`, `Fee` | SDK autofill, checked (§11) |

No memo, `Paths`, `SendMax`, `SourceTag`, `NetworkID` (networks ≤ 1024), or
any caller-chosen field. The PAY-01 business `reference` stays **off-ledger**,
in Frontera evidence — nothing business-identifying is published on chain.

## 9. Amount conversion

The XRPL issued-currency format is a 16-digit mantissa with exponent in
[-96, 80] — at most 15 significant digits exactly. The rail proves, by string
arithmetic, that the canonical decimal fits, and then hands the ledger **the
same text**. No floating point, no rounding. Anything that does not fit is
refused before preparation (`xrpl-amount-not-representable`). On the way
back, the ledger's `delivered_amount` (which rippled may print as `1e-15`) is
converted back to canonical decimal by string arithmetic and compared exactly
with the granted amount.

## 10. Signing boundary and key custody

```
rail ── prepared Payment ──▶ XrplTransactionSigner.sign ──▶ { signedTransaction, hash }
     ◀── verify: decode(blob) signs exactly the prepared payment; hash = hashSignedTx(blob)
```

- The signer is a **port**, domain-aware like the CORE-02 authority signer: it
  signs a prepared XRPL `Payment` for the one account it holds. No raw-byte
  signing, no key export, no key in the rail.
- The rail verifies the answer before submitting: the decoded blob's signing
  encoding must equal the prepared payment's, byte for byte, and the hash
  must be the blob's own. A signer that changed the destination, amount,
  issuer or flags, or added a memo, is refused with nothing submitted
  (`xrpl-signature-mismatch`).
- **PAY-02 ships no production signer.** A host composes one backed by its
  own custody (HSM, external signing service). The software signer used for
  qualification (`tests/xrpl-test-fixtures.ts`) is test-only; boundary tests
  fail the build if `Wallet`, seeds, keypairs or mnemonics appear in any
  production source.
- No seed, key, signed blob or credential ever appears in `PaymentIntent`,
  `PaymentExecutionRequest`, `PaymentRailResult`, logs, errors, evidence,
  trace or configuration output (canary tests X20).

## 11. Execution semantics

| step | does | on failure |
| --- | --- | --- |
| build | asset, source mapping, destination, amount (§5–§9) | `not-completed ADAPTER_ERROR`, nothing contacted |
| connect | `client.connect`, `server_info.network_id` = configured | `not-completed PROVIDER_UNAVAILABLE` / `ADAPTER_ERROR xrpl-network-mismatch` |
| prepare | validated ledger index → `LastLedgerSequence`; autofill `Sequence` / `Fee`; every rail-set field unchanged and nothing else added; fee ≤ ceiling | `not-completed`, nothing signed |
| sign + verify | §10 | `not-completed`, nothing submitted |
| submit | `client.submit` — **once** | §12 |
| finality | `tx` lookups each `pollIntervalMs` until validated, expired, or `finalityTimeoutMs` | §12 |

Payments from one source account run **one at a time** inside one rail
instance — from preparation **through finality** — so a second payment is
never autofilled while the first could still be invisible to `autofill`.
And after an `unconfirmed` outcome, the rail remembers that transaction's
`Sequence` and `LastLedgerSequence`: until the ledger has validated that
`LastLedgerSequence`, a new payment from the same account autofilled with
the same (or a lower) `Sequence` — one that would compete with the unresolved
transaction, only one of them able to validate — is refused **before signing**
(`not-completed PROVIDER_UNAVAILABLE`, `xrpl-sequence-in-flight`). A higher
sequence proceeds. Throughput per source account is therefore one payment per
finality wait.

## 12. Submission versus finality, and the outcome mapping

The `submit` answer is **provisional**: even `tesSUCCESS` there only means the
transaction applied to the server's open ledger. The only final facts are:

- **validated** — a `tx` answer with `validated: true` and
  `meta.TransactionResult`; validated ledgers are immutable;
- **expired** — `txnNotFound` with `searched_all: true` over
  `[first possible ledger, LastLedgerSequence]`, read once the validated
  ledger index has reached `LastLedgerSequence` (that ledger itself
  validated; the protocol forbids inclusion after it);
- **malformed** — a `tem…` submit result: the transaction can never be
  applied.

| what is known | `PaymentRailResult` | P11 |
| --- | --- | --- |
| validated `tesSUCCESS`, `delivered_amount` exactly the granted amount, currency and issuer | `completed`, ref = tx hash | `confirmed-completed` |
| validated `tec…` | `not-completed PROVIDER_REJECTED`, detail = engine code | `confirmed-not-completed` |
| submit `tem…` | `not-completed PROVIDER_REJECTED`, detail = engine code | `confirmed-not-completed` |
| expired (above) | `not-completed PROVIDER_REJECTED`, `xrpl-transaction-expired` | `confirmed-not-completed` |
| refused before submission (§11) | `not-completed`, its reason and detail | `confirmed-not-completed` |
| submission provably not attempted (no open connection) | `not-completed PROVIDER_UNAVAILABLE`, `xrpl-submission-not-attempted` | `confirmed-not-completed` |
| would reuse the sequence of an earlier, still-unconfirmed payment (§11) | `not-completed PROVIDER_UNAVAILABLE`, `xrpl-sequence-in-flight`, nothing signed | `confirmed-not-completed` |
| `submit` threw — timeout, reset, disconnect | `unconfirmed`, ref = hash, `xrpl-submission-outcome-unknown` | `unconfirmed` → P12 |
| `submit` answer unreadable | `unconfirmed`, `xrpl-submission-response-unreadable` | `unconfirmed` → P12 |
| no validated answer by the deadline | `unconfirmed`, `xrpl-finality-unknown` | `unconfirmed` → P12 |
| validated success, delivered ≠ granted | `unconfirmed`, `xrpl-delivered-amount-mismatch` | `unconfirmed` → P12 |
| validated, unrecognized result | `unconfirmed`, `xrpl-result-unrecognized` | `unconfirmed` → P12 |
| rail fault after submission | `unconfirmed`, `xrpl-rail-error-after-submission` | `unconfirmed` → P12 |

No new outcome or failure vocabulary: reasons are the existing
`ExecutionFailureReason`; XRPL specifics are bounded detail tokens
(`xrpl-rail-details.ts`) or the engine result code itself. `tef…`, `tel…` and
`ter…` submit answers are treated as provisional — the validated ledger, or
expiry, decides.

**Provider reference.** The transaction hash (64 uppercase hex) is computed by
signing *before* submission, so every post-submission outcome — including
`unconfirmed` — carries it as `externalReference`, which P11 records as
`providerRef`. It is never the transaction JSON.

## 13. Timeout semantics and the no-retry rule

- A timeout or network error **before** the blob could be written (connect,
  `server_info`, ledger index, autofill, signing, or the SDK's
  `NotConnectedError`) is a definitive local failure: the rail can prove
  nothing was submitted.
- A timeout or error **after** `submit` was called is `unconfirmed`. It is never
  `not-completed`: a caller who believed that would pay twice.
- **`finalityTimeoutMs` is a real upper bound.** Before submission each request
  is bounded by `requestTimeoutMs`. After submission the whole finality phase
  shares one budget: each sleep is capped at what remains, and each read
  (validated index, `tx` lookup) runs under `min(requestTimeoutMs, remaining)`
  through the SDK's own per-request timeout, which rejects and forgets the
  request when it elapses — nothing is left outstanding. No read begins once
  the budget is spent. Exhausting it is `unconfirmed` (`xrpl-finality-unknown`)
  → P12, never `not-completed`, and the account's queue is released.
- **No automatic retry.** `client.submit` is called from one place, at most once
  per `execute`; nothing resubmits, re-signs, re-prepares or reconnects and
  re-sends. Lookups after submission are reads. The SDK client sends
  `fail_hard: true` so a locally failed transaction is not held or relayed.
  The PAY-01 bridge invokes the rail at most once per execution identity, and a
  replay of the governed request returns the recorded outcome.
- XRPL has no generic idempotency key. The protection against a duplicate is
  structural (one submission, no retry) plus the account `Sequence`: one signed
  transaction can be included at most once.

## 14. P12

An `unconfirmed` XRPL payment enters the **existing** P12 flow; there is no
XRPL-specific resolution path in PAY-02. The operator looks up the recorded
`providerRef` (the transaction hash) in an XRPL explorer or with their own
client, and records `confirmed-completed` or `confirmed-not-completed`
through operator resolution. After `LastLedgerSequence` + a few ledgers the
answer is always determinable: validated with a result, or provably never
included. PAY-02 never re-submits, never creates a second payment and never
overwrites the durable provider outcome.

## 15. Evidence, disclosure, logging, health

- **Evidence:** no parallel XRPL record. The rail's safe metadata lands in the
  existing P11 record and ASSURE trace: rail id (`adapterId`), amount and asset,
  source account reference, `providerRef` = transaction hash, certainty and —
  for a definitive failure — the existing failure reason. The bounded detail
  token / engine code travels on the live execution outcome and in the rail's
  log events; P11's durable schema is unchanged and does not store it.
- **Disclosure:** PAY-01's tiers, unchanged — the hash is AUDITOR and PARTNER
  evidence; amount and source are AUDITOR only; CUSTOMER and PUBLIC see the
  business result; no tier discloses the XRPL destination, issuer or source
  address.
- **Logging:** an optional `XrplRailLogger` (structurally a subset of
  `EnterpriseLogger`; pass one as-is). Events `xrpl.payment.prepared`,
  `.submitted`, `.completed`, `.failed`, `.unconfirmed`; fields limited to
  `railId`, `executionId`, `transactionHash`, `engineResult`, `detail`. Never a
  signed blob, address, amount, endpoint or anything a signer holds. A
  throwing logger never changes an outcome.
- **Health / readiness:** `rail.readiness()` → `{ status: 'ready' }` or
  `{ status: 'unavailable', detail }` (connects and verifies `network_id`).
  The Host health model is not changed; an embedder that treats the rail as
  required calls `readiness()` before serving. `rail.close()` disconnects.

## 16. Testnet qualification

Deterministic qualification needs no network: the fake client
(`tests/xrpl-test-fixtures.ts`) scripts validated success, validated failure,
timeouts before and after submission, malformed answers and an unavailable
network, and counts every submission.

The optional live smoke run (`pay02-xrpl-testnet-smoke.test.ts`) is skipped
unless `FRONTERA_XRPL_TESTNET_SMOKE=1`. It uses only XRPL Testnet, ephemeral
faucet-funded accounts and a **stand-in issuer** created for the run (Testnet
RLUSD from Ripple's issuer needs a separate faucet), and drives the real
governed path with the real SDK client. It refuses to run against any server
not reporting `network_id` 1.

## 17. Known limitations

PAY-02 does **not** provide: a production signer or key custody (a host must
compose an `XrplTransactionSigner`); multi-signing orchestration; automatic
TrustSet or trustline preflight (a missing trustline is a validated
`tecPATH_DRY` / `tecNO_LINE` failure); source-balance preflight or treasury
management; liquidity sourcing, FX, DEX or AMM routing, paths or `SendMax`;
issuer transfer-fee handling (a non-zero transfer rate fails as a validated
`tec`); cross-chain; Lightning; a wallet UI; an XRPL-specific P12 resolution
authority (operators resolve by hash); Host-config / deployment-kit
composition; mainnet qualification; automatic retry of an ambiguous payment.
Sequence collisions across *separate processes* signing for the same account
are not coordinated (one fails as expired, definitively).
