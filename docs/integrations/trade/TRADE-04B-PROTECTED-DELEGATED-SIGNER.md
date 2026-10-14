# TRADE-04B — Protected Delegated OfferCreate Signer, External Custody Protocol & Cryptographic Qualification

- Milestone: TRADE-04B (Frontera Governed Trading — XRPL / XLS-75 Design Partner Edition)
- Branch: `feat/trade-04b-protected-delegated-signer`
- Baseline: `main @ 11db917c` (PR #187, TRADE-04A merged; TRADE-00 … TRADE-03 and PAY-01 … PAY-09 present)
- Depends on: TRADE-01 (canonical OfferCreate contract), TRADE-02 (XLS-75 delegation verification),
  TRADE-03 (granular governance), TRADE-04A (shared XRPL transport; `ADR-XRPL-SHARED-TRANSPORT.md`),
  PAY-03 (external XRPL signer pattern), CORE-02 (external signer endpoint rules)
- Status: implemented locally; not pushed, no PR, not merged. Verdict in §30.

> **TRADE-04B cannot execute a governed order.** It builds a narrowly scoped signing capability
> and the cryptographic checks around it. Nothing in this milestone submits a transaction,
> composes the signer into the Host, or connects it to the bounded-grant path. A signed
> OfferCreate produced here is **signed, not submitted** — never an authorization, an execution
> or a fill.

## 1. Executive summary

A professional trading firm keeps its owner account's keys and authorizes a **delegate** account on
the ledger (XLS-75 `DelegateSet`, permission `OfferCreate`). TRADE-04B lets Frontera obtain that
delegate's signature on exactly one closed shape of transaction — an unsigned, single-signed,
delegated `OfferCreate` — from a separately hosted signer, without Frontera ever holding a trading key.

It delivers three strictly separated components in `src/enterprise/xrpl-trade-rail/`:

| Component | File(s) | Holds a key | Network |
|---|---|---|---|
| A. Closed protocol `frontera.xrpl-delegated-offer-signer.v1` | `delegated-offer-protocol.ts` | no | none |
| B. Host-side client + verifier + HTTP transport | `delegated-offer-signer.ts`, `delegated-offer-verification.ts`, `delegated-offer-signer-transport.ts` | **no** | one configured signer endpoint (EP-073) |
| C. Reference signer (separate process) | `reference/reference-delegated-offer-signer.ts`, `scripts/run-reference-xrpl-offer-signer.mjs` | disposable **delegate** keys only | inbound, literal loopback only; never XRPL |

Plus the narrowly authorized approval gate **G3**: the transaction-neutral signed-blob primitives,
including `signedByPinnedKey`, moved from the PAY-02 codec into the shared transport by substitution
(`src/features/xrpl-transport/xrpl-signature.ts`), with Payment behavior proven identical.

The signer decides nothing. Whoever can reach it with its credential can have any closed, in-bounds
OfferCreate signed for a configured pair; **TRADE-04C must ensure only grant-bound, validated
execution requests reach the signing capability.**

## 2. Baseline

| Check | Result |
|---|---|
| Worktree | `/mnt/c/Users/Usuario/source/Republika-Network/Frontera-trade-04b` |
| Branch | `feat/trade-04b-protected-delegated-signer`, clean, `HEAD = origin/main = 11db917c` |
| TRADE-04A | PR #187 `MERGED` 2026-10-14T03:43:07Z, merge commit `11db917c4a203827a4b1f51366334f330f4379a5` |
| TRADE-00 … 03, PAY-01 … 09 | present in history (`919c175`, `d04b8b6`, `e377f34` … `6adfe45`) |
| Pre-existing TRADE-04B code / conflicting PR | none (open PRs: #164, #141, #96 — unrelated) |
| Baseline focused suites | PAY-02/03, shared transport, TRADE-04A, TRADE vertical: **331/331 pass** before any change |
| SDK | `xrpl 5.3.0`, `ripple-binary-codec 2.11.0`, `ripple-keypairs 3.1.0` (exact pins) |

## 3. Architecture

```
future executor (TRADE-04C, below the bounded grant)         delegate custody (customer-operated or reference)
───────────────────────────────────────────────────          ─────────────────────────────────────────────────
DelegatedOfferSigningPort.signDelegatedOffer({ transaction, audit, validatedLedgerIndex })
  │  B. createDelegatedOfferSigner (Host process — no key)
  ├─ closed OfferCreate, pinned pair, Host fee ceiling, LLS horizon     → refused locally, nothing sent
  ├─ identity proven against the pin (no TOFU; MISMATCH permanent)
  ├─ fresh 32-byte requestId ── EP-073: POST /v1/sign/xrpl-delegated-offer ──▶  C. reference signer (separate process)
  │                                                                              ├─ auth, JSON, ≤16 KiB, closed request
  │                                                                              ├─ signer id, network, held pair, replay
  │                                                                              ├─ fee ceiling, [LLS vs injected ref], [Expiration vs clock]
  │                                                                              ├─ Wallet.sign (delegate key, single-sign)
  │                                                                              └─ self-verify, answer
  ├─ response bound to requestId, signer, owner, delegate
  └─ verifySignedDelegatedOffer: canonical, exact field set, same signing bytes,
       PINNED delegate key, valid signature, own hash
       → VerifiedDelegatedOfferSignature { status: 'signed-not-submitted' }
```

Placement was chosen against the structural rules: TRADE itself (`src/features/trade-runtime`) may
not sign, name a signer operation, import the SDK or open a socket (`trade-vertical-structure.test.ts`),
so the signer lives in an enterprise edge, like PAY-03's. The edge reads TRADE-01's grammar
(amounts, currency codes, addresses, offer flags), which makes it the **second approved TRADE
composition edge** (user approval, 2026-10-13; held to `trade04b-protected-signer-structure.test.ts`).
It is classified outside the PAY-07 qualified CORE (`pay07-core-source-manifest.ts`) and is scanned by
PAY-04 M39 like every other enterprise directory.

## 4. Exact protocol schema

Protocol `frontera.xrpl-delegated-offer-signer.v1`; one operation `sign-xrpl-delegated-offer`.
Distinct from PAY-03's `frontera.external-xrpl-transaction-signer.v1` / `sign-xrpl-payment` in id,
operation, path, request and response.

| Path | Method | Body |
|---|---|---|
| `/v1/identity` | GET | — → identity |
| `/v1/sign/xrpl-delegated-offer` | POST | request → response |

```jsonc
// identity
{ "protocol": "frontera.xrpl-delegated-offer-signer.v1", "signerId": "<^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$>",
  "operations": ["sign-xrpl-delegated-offer"], "network": "xrp-ledger-testnet" | "xrp-ledger-devnet",
  "pairs": [ { "ownerAccount": "r…", "delegateAccount": "r…", "signingPublicKey": "<33 bytes, uppercase hex>" } ] } // 1…64, distinct

// request
{ "protocol": "…v1", "signerId": "…", "requestId": "<64 lowercase hex = 32 random bytes>",
  "network": "xrp-ledger-testnet" | "xrp-ledger-devnet", "ownerAccount": "r…", "delegateAccount": "r…",
  "transaction": <PreparedDelegatedOffer, §6>,               // Account = ownerAccount, Delegate = delegateAccount
  "audit": { "executionId": "<id>", "grantRef": "<id>", "grantDigest": "sha256:<64 hex>" } }

// response
{ "protocol": "…v1", "signerId": "…", "requestId": "…", "ownerAccount": "r…", "delegateAccount": "r…",
  "signedTransaction": "<uppercase hex, 32…4096 bytes>", "hash": "<64 uppercase hex>" }
```

All three are exact, closed, plain-JSON records: an unknown, missing or extra field, an accessor, a
symbol key, an own `__proto__`, a non-plain object or an array with extra own keys is refused, never
ignored. The request carries **no** private key, seed, raw bytes, algorithm choice, custom metadata
or signer policy; the `audit` block is recordable references only and is labeled as such — it is
**not** signer-side verification of governance, and a serialized grant cannot be smuggled in
(it is an unknown field). The caller never states the signer's identity mapping.

## 5. Identity and key pinning

The deployment pins, per signer: `signerId`, `network`, and the **set** of
`(ownerAccount, delegateAccount, signingPublicKey)`. The identity answer must equal the pin exactly —
same protocol, signer id, single operation, network, and the same pair set with the same keys,
**none missing and none extra**. Nothing advertised is ever adopted: no TOFU, no silent key
discovery, no automatic adoption of new accounts, no fallback key, no wildcard owner.

`validateDelegatedOfferSignerPins` refuses, across all of a deployment's signers: a repeated signer
id, a pair pinned twice, and one pair under two signers (one relationship, one custodian — a pin is
never reused across signers or customers without explicit, separate configuration).

| State | Meaning | Signing |
|---|---|---|
| `UNVERIFIED` | never proven since construction | forced handshake first |
| `VERIFIED` | last handshake proved the pin; nothing since contradicted it | allowed; **every** answer still fully verified |
| `UNAVAILABLE` | last contact failed: unreachable, timeout, 5xx/429, credential refused, malformed answer | forced handshake first — a once-proven identity is **not** assumed across an outage |
| `MISMATCH` | identity differs, or an answer for another request/signer/pair, or a blob that fails verification | refused for the life of the client; rotation = configuration + new client |

A signer refusal (4xx other than 401/403, e.g. its own fee ceiling) leaves the state unchanged.
Probes are single-flight and rate-limited (`probeIntervalMs`). Tested: wrong owner, wrong delegate,
wrong key, swapped keys between two pairs, extra pair, other network, duplicate pair, duplicate signer
id, rotated key after prior verification (also over real loopback, restarting the reference signer
with a new key under the same id).

## 6. Prepared OfferCreate closure

Exactly these fields (`DELEGATED_OFFER_REQUIRED_FIELDS` / `…OPTIONAL_FIELDS`):

| Field | Rule |
|---|---|
| `TransactionType` | `"OfferCreate"` |
| `Account` | owner; valid classic address, not a reserved account |
| `Delegate` | delegate; valid, not reserved, `≠ Account` |
| `TakerGets` | what the owner **gives**; canonical wire amount |
| `TakerPays` | what the owner **receives**; canonical wire amount; different asset from `TakerGets`; not XRP-for-XRP |
| `Flags` | integer, bits ⊆ TRADE-01's `passive | immediate-or-cancel | fill-or-kill | sell` (`0x000F0000`); not IoC + FoK; no `tfHybrid`, no universal flag |
| `Sequence` | integer 1 … 2³²−1 |
| `Fee` | drops, `^[1-9][0-9]{0,15}$` |
| `LastLedgerSequence` | integer 1 … 2³²−1 |
| `Expiration` (optional) | integer 1 … 2³²−1 |

Amounts reuse TRADE-01's grammar and **refuse rather than normalize**: XRP is a string of whole drops
(canonical positive integer ≤ 10¹⁷, never a number or a fraction); an issued amount is exactly
`{ currency, issuer, value }` with a canonical decimal (no trailing fractional zero, exponent, sign,
leading zero or more than 16 significant digits), an explicit valid issuer, a three-character code
kept as written or a 40-hex code already in upper case (not `00`-prefixed), and never `XRP`. There is
no implicit USD parity and no number conversion anywhere. Refused outright: `Memos`, `Signers`,
`SigningPubKey`, `TxnSignature`, `OfferSequence`, `DomainID`, `NetworkID`, `TicketSequence`,
`SourceTag`, Payment fields and any unknown field. `NetworkID` is deliberately absent: the
ledgers this contract admits (Testnet id 1, Devnet id 2) are below 1025 and must not carry it.

Why refuse rather than normalize: the SDK silently re-spells some inputs when it encodes (`"1.50"`
and `"1e3"` become `1.5` and `1000` on the wire — characterized in §7). A Host that accepted
`"12.50"` would be signing bytes that differ from the text it compared. Only one spelling passes.

## 7. XRPL signing and verification model

**SDK characterization** (`trade04b-delegated-offer-signature.test.ts`, offline):

- `Wallet.sign(tx)` on a delegated OfferCreate **single-signs as the delegate**: `SigningPubKey` is
  the delegate key, `Account` stays the owner, `Delegate` is serialized and is a **signing field**
  (`isSigningField: true` in `ripple-binary-codec` 2.11.0 definitions) — removing it changes the
  preimage. The SDK's own validation refuses `Account == Delegate`. It does **not** refuse a `Memos`
  field, so the closure above is Frontera's, not the SDK's.
- Signing is deterministic per key and transaction (ed25519 RFC 8032; secp256k1 RFC 6979): the same
  request yields the same blob. Both algorithms are qualified.
- The preimage is `STX\0 ‖ canonical signing fields`; the transaction id is
  `SHA-512Half(TXN\0 ‖ blob)`. `verifySignature(blob, key)` verifies `TxnSignature` over the blob's
  own preimage. Nothing about the ledger's acceptance (the delegate's key on its account root, the
  delegation entry) is checkable offline — see §11.

**Host-side verification** (`verifySignedDelegatedOffer`), in order, each with a closed failure:

1. blob is uppercase hex 32…4096 bytes (`BLOB_MALFORMED`); hash is 64 uppercase hex (`HASH_MALFORMED`);
2. the prepared transaction re-parses as the closed contract (`PREPARED_INVALID`) for exactly the
   pinned owner and delegate (`PAIR_MISMATCH`);
3. the blob decodes (`BLOB_UNDECODABLE`) and re-encodes to exactly itself (`BLOB_NOT_CANONICAL` —
   catches reordered, duplicated or trailing fields);
4. its field set is exactly the prepared fields + `SigningPubKey` + `TxnSignature`
   (`FIELD_SET_MISMATCH` — no `Signers`, no `Memos`, nothing added or missing);
5. `TransactionType` (`TRANSACTION_TYPE_MISMATCH`), `Account` (`OWNER_MISMATCH`), `Delegate` (`DELEGATE_MISMATCH`);
6. `SigningPubKey` equals the **pinned** delegate key (`SIGNING_KEY_MISMATCH`);
7. its single-signing encoding equals, byte for byte, the prepared transaction's under that key
   (`TRANSACTION_MISMATCH`);
8. `signedByPinnedKey` — the signature verifies under the pinned key, no `Signers` (`SIGNATURE_INVALID`);
9. the reported hash equals the recomputed one (`HASH_MISMATCH`).

The reference signer runs the same verifier on its own output before answering.

## 8. Owner versus delegate custody

| Key | Who holds it | Used by TRADE-04B |
|---|---|---|
| Owner account key | the customer, always | **never** — no field, route, file or environment variable can carry it |
| Delegate signing key | the delegate custodian (customer-operated signer, or the reference process for isolated Testnet qualification) | only inside the signer process |
| Signer credential (bearer) | Host transport closure + signer | authenticates the channel; never a key |

The owner's control over what the delegate may do is the ledger's (XLS-75 permissions; revocable by
the owner at any time). The delegate's `Sequence` is untouched: a delegated transaction consumes the
**owner's** `Sequence` and the delegate pays the fee (TRADE-00 §5).

## 9. Host / external-signer trust boundaries

The Host trusts the signer for **availability only**. It trusts nothing it answers: the identity is
compared with the pin, every answer is correlated, and every blob is verified as in §7. An endpoint
that is not the pinned key's custodian can deny service; it cannot produce an accepted signature. A
compromised signer **can** sign any closed, in-bounds OfferCreate for its pairs — which is exactly why
the signer must be reachable only from the grant-bound executor (TRADE-04C) and why the delegate's
on-ledger permission should be the narrowest XLS-75 allows.

## 10. Reference signer operational limits

NOT an HSM, NOT a KMS, NOT hardware-backed, NOT a custody certification, NOT for unattended
institutional custody. It exists so the Host can be qualified with no trading key in the Host.

- Separate process (`scripts/run-reference-xrpl-offer-signer.mjs`); never imported by the Host.
- Binds a **literal** loopback address only (`127.0.0.0/8`, `::1`); `localhost`, `0.0.0.0`, `::`
  and every other address are refused before a socket opens.
- Holds 1…64 disposable delegate keys from **its own** key file; never an owner key.
- Imports only `Wallet` and `ECDSA` from the SDK; opens no XRPL connection; reads no ledger state;
  submits nothing; has no key-export, raw-signing or other route.
- Static restrictions (defence in depth, never governance): exact held pair, its network, its fee
  ceiling, request-id replay refusal (last 4 096), `LastLedgerSequence` horizon **only** against an
  injected trusted validated index (absent → explicitly deferred; it never estimates a ledger
  position from its clock), `Expiration` not already past by its clock (absent → deferred).
- Key file: created **only** by the explicit `create-key` command — create-only (`wx`), mode
  `0600`, re-checked after creation; on a filesystem that does not enforce Unix permissions the file
  is removed and creation refused. Loading refuses a missing file (never creates), a symlink, a file
  not owned by the user, any group/other bit, another format, another network, or an owner's own
  key. The public identity goes to `<file>.pub` (create-only, no secret). No seed in arguments,
  errors, logs or the Host environment.
- **WSL note (characterized):** under `/mnt/c` (drvfs, 9p, no `metadata` option) every file reports
  `0777` and `chmod` has no effect, so key files there are refused; use a Linux filesystem
  (e.g. `~/` or `/tmp` inside WSL). `trade04b-reference-signer.test.ts` proves the refusal on this
  machine and skips that case on filesystems that enforce modes (CI).
- **No persistent key was generated in this milestone.** Tests create ephemeral keys in fresh OS
  temporary directories and remove them.

## 11. Network and permission assumptions

- **Network binding is configuration, not cryptography.** The protocol names the network and the
  signer refuses another, but for Testnet/Devnet (ids ≤ 1024) the signed transaction carries no
  `NetworkID`, so a signature does not cryptographically bind a network. An owner that exists with
  the same `Sequence` on two networks could, in principle, have one blob replayed on the other; the
  bound is the owner's per-network `Sequence` and the short `LastLedgerSequence` window. Mainnet is
  not representable anywhere in the contract.
- **Delegation and key validity are ledger facts** the signer never reads: that the delegate holds
  `OfferCreate` permission from the owner (TRADE-02's verifier over a validated read) and that the
  pinned key controls the delegate account (master key not disabled, or its regular key). Both are
  TRADE-04C's validated re-reads immediately before signing (§25).
- **Sequence and LLS** are taken from the prepared transaction; their freshness is the executor's
  (validated index from the TRADE-04A reader). The Host-side client requires a caller-supplied
  validated index and bounds `LastLedgerSequence` within `(index, index + horizon]`.

## 12. Why the signer does not independently make governance decisions

Governance — proposal admission, risk assessment, the CORE decision, the bounded grant, the P11
single-use claim — happens before signing, in Frontera, once. A signer that re-evaluated policy would
be a second governance engine with a second, unaudited answer. Its fee ceiling, horizon and expiry
checks are operational guards that can only **refuse**; they never grant. Audit references are
recorded, never verified. Correspondingly, **a valid signature does not prove Frontera governance**:
that proof is the grant-bound executor's (TRADE-04C) and its evidence chain.

## 13. Defense against parameter substitution

| Substitution | Caught by |
|---|---|
| Amount, issuer, currency, swapped sides, flags, expiration, fee, `Sequence`, LLS | signing-bytes equality (`TRANSACTION_MISMATCH`) |
| Owner / delegate | `OWNER_MISMATCH` / `DELEGATE_MISMATCH`, and the response's pair binding |
| Added field (signing or not), removed field, `Signers` | `FIELD_SET_MISMATCH` |
| Another key | `SIGNING_KEY_MISMATCH`, then `SIGNATURE_INVALID` |
| Transplanted, flipped, wrong-preimage or multisign-preimage signature | `SIGNATURE_INVALID` |
| Reordered / non-canonical bytes | `BLOB_NOT_CANONICAL` |
| Wrong reported hash | `HASH_MISMATCH` |
| Non-canonical input spelling | refused at parse (never normalized) |

200 generated single-field substitutions over 40 offers are all refused (§18).

## 14. HTTP transport security (EP-073)

`createHttpDelegatedOfferSignerTransport`: `https:` with Node's default certificate verification, or
plain `http:` to a **literal** loopback IP only (`localhost` refused — its resolution is the host's,
not the transport's; `[::ffff:127.0.0.1]` refused); no credentials, query, fragment or path in the URL
(CORE-02's rules plus the literal-loopback narrowing). One bearer credential in the closure only.
One attempt per call, one time budget (request destroyed on expiry), `agent: false`, request body
≤ 16 KiB checked before sending, response ≤ 16 KiB, a `200` accepted only as `application/json`,
3xx never followed, refusal bodies never parsed, closed failure reasons, no status text or address
propagated. Not a generic proxy: two fixed paths. Inventoried as NO_BYPASS **EP-073**
(DEPLOYMENT-GATED; denominator 72 → 73, numerator unchanged at 11), composed by nothing.

## 15. Request / response replay handling

- Host: a fresh 32-byte random `requestId` per signature; the answer must carry it (and the pinned
  signer id, owner and delegate) or it is `RESPONSE_MISMATCH` and the client enters `MISMATCH`. A
  replayed genuine answer for an identical transaction is refused this way. An injected generator that
  repeats an id (last 4 096 remembered) or emits a malformed one is refused locally.
- Signer: a repeated `requestId` is `409 request-replayed` (last 4 096).
- Deterministic signatures mean a duplicate signature over the same prepared transaction is the same
  blob — harmless by itself; double-submission is prevented by TRADE-04C's durable reservation, not here.

## 16. Key rotation

Rotation is explicit: generate a new delegate key in custody, authorize it on the ledger (owner's
`DelegateSet` for the new delegate account, or the delegate's `SetRegularKey`), change the Host pin,
restart the Host-side client, re-qualify (handshake + one offline test vector), then revoke the old
delegation. A signer that rotates on its own is `MISMATCH` until the pin changes — tested. There is
no implicit rotation, no "accept the new key once".

## 17. Credentials and endpoint configuration

Host side (a future TRADE-04C composition): endpoint (https, or literal loopback http), bearer
credential (≥ 32 chars, no whitespace, never logged, never in a URL), pin (§5), `timeoutMs` (1…60 000),
`maximumFeeDrops` (≤ 1 XRP), `maximumLedgerHorizon` (1…1 000), `maximumConcurrentSignatures`
(1…64, default 8), `probeIntervalMs`. Credential rotation: issue a new credential at the signer,
update the Host secret, restart; the old credential is refused (`AUTHENTICATION_FAILED` →
`UNAVAILABLE`, not `MISMATCH`).

Reference side: `FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_{KEY_FILE,ID,TOKEN,MAX_FEE,PORT,HOST}` in the
**signer's** environment only. (PAY-03's Host guard refuses `FRONTERA_REFERENCE_XRPL_SIGNER_*` when the
Payment rail is configured; an equivalent guard for these names belongs to the TRADE-04C Host
composition — §25.)

## 18. Negative test matrix

All offline or loopback; real signatures; no mocked verification.

| Matrix | File | Cases |
|---|---|---|
| A. Protocol grammar | `trade04b-delegated-offer-protocol.test.ts` | valid identity; missing/wrong protocol; Payment protocol; wrong/additional/no operation; unknown field; mainnet; no pairs; duplicate pair; invalid/reserved address; owner = delegate; invalid key (case, length); seed in a pair; malformed signer id; 65 pairs; class instance, accessor, symbol, inherited, own `__proto__`, array-like and extra-key arrays; request: malformed request id ×3, invalid/credential-shaped execution ref, empty grant ref, bad digest, smuggled grant, missing audit, owner/delegate not matching the transaction, malformed transaction, algorithm, private key, seed, raw bytes, metadata, policy override, mainnet, Payment protocol; response closure ×7 |
| B. Transaction closure | same | 7 valid shapes; 56 refusals incl. Payment, OfferCancel, bad Account/Delegate, Account = Delegate, missing TakerGets/TakerPays, XRP as number/fraction/leading zero/zero/above supply/object, issued trailing zero/exponent/negative/17 digits/number/`XRP`/lower-case hex/bad issuer/reserved issuer/no issuer/extra field, XRP-for-XRP, same asset, tfHybrid, tfFullyCanonicalSig, tfInnerBatchTxn, IoC+FoK, negative/text flags, Sequence 0/1.5/2³², LLS 0/text, Fee number/0/fraction/17 digits, Expiration 0/2³²/text, Memos, Signers, SigningPubKey, TxnSignature, OfferSequence, DomainID, NetworkID, TicketSequence, SourceTag, Destination, Amount, unknown |
| C. Signature integrity | `trade04b-delegated-offer-signature.test.ts` | SDK characterization ×2 algorithms; positive vectors ×2; determinism ×2; pinned vectors ×2; changed TakerGets, TakerPays value, issuer, currency, swapped sides, flags, expiration, owner, delegate, Sequence, Fee, LLS, transaction type; added Memos, SourceTag, Signers; removed Expiration; replaced key; other key's real signature; other key's signature transplanted; flipped byte; signature over another transaction; non-delegated preimage; multisign preimage; multisigned blob; wrong/malformed/absent hash; lower-case, odd-length, oversized, undersized, non-string blob; undecodable; reordered and trailing bytes; non-closed prepared; other pair; 200 generated substitutions |
| D. Identity and HTTP | `trade04b-delegated-offer-signer-client.test.ts` | verified signer; wrong signer id; changed owner/delegate/key; extra pair; other network; swapped keys; rotation after verification; unavailable ≠ mismatch and re-proof; single-flight probes; BUSY bound; wrong request id/signer/owner/delegate; wrong hash; other key; other transaction; replayed answer; repeating/malformed id generator; malformed answer; 8 local refusals with zero contact; pins/bounds/endpoints/credential validation; no value in config errors; real loopback reference signer; wrong credential; rotated reference key; HTTP 401/403/429/500/302/307/204 with secret-shaped body never echoed and one request each; invalid JSON; non-JSON content type; oversized response; timeout; unreachable; oversized request not sent; credential only in the header |
| E. Custody and isolation | `trade04b-reference-signer.test.ts` | signs and verifies; two pairs isolated; refuses Payment, raw bytes, key export, other signer, other network, unserved owner, fee, Memo, SigningPubKey before touching a key; replay; LLS horizon only with injected reference; Expiration by clock; auth on every route, JSON only, 413, no export/seed/submit/payment routes, 405s; no seed/credential in answers; bad configuration ×7 with no seed in errors; loopback bind and 8 refused binds; key file create-only 0600 with public `.pub`; no overwrite; no create on load; refuses 0644, symlink, other format, mainnet, extra entry field; exact mode rule; `/mnt/c` refusal on this machine |
| F. Future integration | `trade04b-protected-signer-structure.test.ts` | typed TRADE-04C consumer over the port; a signature is read as **no** execution adapter result (`readExecutionAdapterResult` → `undefined`; a compile-time `@ts-expect-error`); no path from any public surface; TRADE-04A sequence tripwire intact |
| Mutation (AC-14) | `trade04b-mutation.test.ts` | 15 mutants, all detected — §20 |

## 19. Cryptographic vectors

Pinned, reproducible vectors — keys derived from fixed entropy exactly like PAY-02's `testWallet`
(no seed literal in source; never funded; anyone can re-derive them, which is why they must never hold
value). Expected values were computed with the SDK directly, outside Frontera's code, and are compared
against the reference signer's output and verified by the Host-side verifier.

Owner `rMfcHpRTwL75cGfVHJJVAwzKp78rkPGocG`, issuer `rpTGWAKD3mCJqEihErL7gBuz1UCAgBHkfR`; offer: give
25 XRP (`"25000000"`), receive 12.5 USD, `tfSell` (`0x00080000`), `Sequence` 41, `Fee` 12, LLS 1 020,
`Expiration` 800 000 000. Preimage prefix `53545800 120007 2200080000 2400000029 2A2FAF…`.

| Algorithm | Delegate | Signing public key | Blob | Transaction hash |
|---|---|---|---|---|
| ed25519 | `rPoY6dFb3vdEX8cafRWF9PwuAc57SLPQKZ` | `ED8243B3B1A523ECDF8B54A3912A6A46E005A5821B2E2F79EA1756DC988A9A6F51` | 236 B | `5764C9BCCAD35080BC34303E63207502EB037A1711E891251D80635C81726DF3` |
| secp256k1 | `rDLjMFbPpGL2qQMRJjVmhXvpB3cjhmqJCr` | `03820957B8A49B43FA7F9A255354245192BF4DF0AB7A72B114156DB4990FC0F49E` | 243 B | `80CFE8A620BECA98E5B946123507D0DA43431A121EEF0EBD601A0F6F0D59AD97` |

Negative vectors: every row of §13, built per run with freshly generated keys.

## 20. Security invariants

TRADE-local numbering (as TRADE-04A's; no global `SEC-INV` range is allocated —
`docs/security/SECURITY_INVARIANTS.md` gains only the EP-073 count update).

| ID | Invariant | Evidence |
|---|---|---|
| SEC-TRADE04B-01 | Only OfferCreate is signable | protocol B; reference E; structure (one operation, two paths) |
| -02 | Owner private key never required | structure (no owner-key field anywhere); protocol A (no key/seed field) |
| -03 | Delegate ≠ owner | protocol A/B; reference configuration; mutation P1 |
| -04 | Signer identity pinned | client D (signer id, network, set equality) |
| -05 | Delegate public key pinned | client D (changed/swapped/rotated keys); verification step 6/8 |
| -06 | No TOFU | client D (extra pair, rotation); mutation C2 |
| -07 | Signed transaction = prepared transaction | signature C; mutation V4 |
| -08 | Unknown fields refused | protocol A/B; verification step 4; mutation P4 |
| -09 | Hash independently verified | signature C; mutation V2 |
| -10 | Signature independently verified | signature C (real signatures, both algorithms); mutation V3 |
| -11 | Replay / mismatched request id cannot pass | client D; reference E; mutations C1, R2 |
| -12 | Signer has no submission capability | structure (no submit/Client/autofill/interlock in the edge) |
| -13 | Host holds no trading key | structure (custody scan: only the reference process) |
| -14 | Signer secrets never logged | structure (no logging in the edge; launcher prints public identity); reference E; client D (no echo) |
| -15 | Payment signer protocol unchanged | structure; TRADE-04A/PAY-03 suites unchanged and passing |
| -16 | No Mainnet/Testnet writes | structure (no submit, faucet, mainnet); tests loopback-only |
| -17 | Fees and ledger bounds enforced where trusted data permits | client D (Host fee, LLS horizon); reference E (fee; LLS only with injected reference); mutations C3, C4, R1 |
| -18 | Reference signer cannot bind publicly | reference E; structure; mutation R3 |
| -19 | Redirects and untrusted endpoints refused | client D (302/307, endpoint rules); structure |
| -20 | Signing failures are not submission results | structure (closed vocabularies; `signed-not-submitted`) |
| -21 | No new bypass of the bounded-grant path | structure (nothing composes the edge); NO_BYPASS EP-073 |
| -22 | Payment transactions not broadened | structure; G3 preservation |
| -23 | Accounts/identities cannot be swapped across customers | client D (swapped keys, extra pair, cross-signer pins); reference E (pair isolation) |
| -24 | No key export, no arbitrary bytes | structure (arbitrary-capability scan); reference E (routes) |

**Mutation results (AC-14):** V1 canonical serialization, V2 hash, V3 signature, V4 signing bytes,
P1 owner ≠ delegate, P2 flag mask, P3 no-normalization, P4 closed field set, C1 request correlation,
C2 exact pin, C3 Host fee ceiling, C4 LLS lower bound, R1 reference fee ceiling, R2 replay,
R3 loopback bind (attempted on TEST-NET-1 `192.0.2.1`, so no public socket ever opens) — **15/15
detected**. Layered checks whose single removal leaves a later refusal (the `SigningPubKey`
comparison, the field-set closure) are pinned by their individual failure codes instead.

## 21. Payment regression evidence

- G3 by substitution (`ADR-XRPL-SHARED-TRANSPORT.md` §12): `xrpl-codec.ts` no longer imports the SDK;
  `signedByPinnedKey` is re-exported as the same function object; `signedPaymentMatches` keeps its own
  closure and its total behavior (a `try` wraps the prepared-payment read exactly as before).
- `xrpl-codec-signature-preservation.test.ts`: the pre-move functions, frozen verbatim, answer
  identically to the shipped ones over 60 real signed Payments (ed25519 and secp256k1), 12 single-field
  tampers, a foreign-key blob, a multisigned blob, transplanted signatures, malformed input and a
  throwing prepared payment.
- Payment parser, signer protocol, external signer, transport and reference service: byte-identical
  to `11db917c` (`git diff 11db917c -- src/enterprise/xrpl-payment-rail` is empty).
- Every PAY-02 / PAY-03 / TRADE-04A suite passes; the four structural suites changed only by the named
  substitutions (§23 of the final report lists each assertion changed and why).

## 22. Latency and throughput measurements

Command: `node scripts/trade/bench-delegated-offer-signer.mjs --iterations 300 --concurrency 8`
(after `npm run build`). Machine: this WSL2 development box, Node v22.23.1, linux/x64, the worktree on
`/mnt/c`. Single process: the reference signer and the Host-side client share one event loop, so
the concurrency figure measures both sides' CPU together.

| Measure (ms) | ed25519 mean / p50 / p95 / p99 | secp256k1 mean / p50 / p95 / p99 |
|---|---|---|
| Host-side verification | 5.19 / 4.37 / 10.00 / 13.66 | 4.80 / 4.19 / 7.77 / 10.82 |
| Request serialization | 0.032 / 0.026 / 0.057 / 0.119 | 0.035 / 0.028 / 0.056 / 0.306 |
| In-process reference signing (parse, checks, sign, self-verify) | 8.65 / 8.16 / 13.30 / 18.77 | 8.34 / 7.15 / 14.30 / 19.01 |
| Loopback identity handshake | 1.45 / 1.21 / 2.38 / 5.03 | 0.83 / 0.79 / 1.05 / 2.47 |
| Loopback signing round trip (client → HTTP → sign → verify) | 13.74 / 13.06 / 19.08 / 22.57 | 12.97 / 12.70 / 16.38 / 19.46 |
| Bounded concurrency (8 in flight, 304 signatures) | 77.6 signatures/s; RSS +15.6 MiB, heap +8.4 MiB | 68.9 signatures/s; RSS +10.2 MiB, heap +14.2 MiB |
| Timeout refusal (100 ms budget) | 100.8 p50 | — |

Reading: signing and verification are CPU-bound pure-JavaScript cryptography (`@noble` curves under
the SDK). The verifier decodes a blob three times (field set, canonical check, `signedByPinnedKey`)
and computes two preimages; a single-decode path is an available optimization that changes no
check. These are **diagnostics of the signing capability on one machine**, not XRPL execution
throughput (ledger close ≈ 3–5 s, submission and validation are not measured) and not evidence of
HFT readiness. Separately, TRADE-03 admits **one pending binding per actor/owner** — an order-flow
limit of the governance path, independent of signer concurrency, which this milestone does not change.

## 23. Customer-hosted signer design

The preferred design partner runs its own signer inside its infrastructure, implementing this
protocol (Frontera supplies the protocol, the Host-side client and verifier, and the reference
implementation to test against). The customer discloses no strategy, model, signal or optimizer —
the signer sees only the closed OfferCreate. Requirements on a customer signer: exactly the two
paths; the closed request grammar (reuse `parseDelegatedOfferSigningRequest` semantics); its own
pair set, network and fee ceiling; refusal of replayed request ids; hardware-backed or KMS custody of
the delegate key at the customer's discretion; mTLS or private networking in front of the bearer
credential where available (a custom `DelegatedOfferSignerTransport` implements the same port).

**Limits of control.** This design does not force all of the customer's trading through Frontera.
That holds only while the delegate key is usable exclusively through the Frontera-reachable signer
and the owner grants no other delegate or key the `OfferCreate` permission. A customer (or an
attacker holding the delegate key) can sign outside Frontera; a compromised delegate can place any
offer its ledger permission allows until the owner revokes it. Frontera's guarantee is about what
*Frontera* causes to be signed.

## 24. Testnet demo prerequisites (not performed here)

1. A Linux filesystem for the reference key file; `create-key xrp-ledger-testnet <owner>`.
2. A funded Testnet owner account (customer-held key) and a funded delegate account (fees).
3. Owner submits `DelegateSet` granting `OfferCreate` to the delegate (TRADE-02 verifies it).
4. Pin the `.pub` identity in the Host; start the reference signer; handshake.
5. TRADE-04C composition (gated) — without it nothing can be submitted.

No account was created or funded, and no transaction was submitted, in TRADE-04B.

## 25. TRADE-04C adapter requirements

TRADE-04C must, in this order (ADR §8 and TRADE-00): (1) trusted proposal admitted; (2) TRADE-03 risk
assessment; (3) CORE decision; (4) bounded grant; (5) P11 single-use execution claim; (6) a
**validated-ledger re-read** of the XLS-75 delegation (TRADE-02 verifier over the TRADE-04A reader) and
of the delegate's key binding (account root: master key enabled, or regular key = pinned key);
(7) prepare the OfferCreate **only from granted canonical terms** (owner `Sequence` from a validated
read; `LastLedgerSequence` from the validated index); (8) call `DelegatedOfferSigningPort` with that
validated index; (9) rely only on the returned `VerifiedDelegatedOfferSignature`; (10) a durable
`Sequence` reservation on a **disjoint** owner account (no G1) with its own CORE-07 slot — gate G4;
(11) exactly one submission — gate G2; (12) validated reconciliation and evidence. It must also
compose the client **below the bounded grant** (so EP-073 is reached only inside the grant path), add
a Host environment guard for `FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_*`, declare its sequence domain
through `assertXrplSequenceOwnership`, and pin the client's endpoint, credential and pin as trusted
Host configuration.

## 26. TRADE-04D recovery requirements

Offer outcome reading from validated metadata (resting, partially filled, filled, killed, expired,
`tec` with fee consumed); proven non-inclusion after `LastLedgerSequence` (`xrplNonInclusionProven`);
recovery of an `unconfirmed` reservation without re-signing (the same execution is never signed
twice — signing again yields the same deterministic blob, which recovery must not resubmit blindly);
P12 resolution from ledger evidence; restart quarantine for the trade domain.

## 27. Commercial integration limitations

- No execution yet: TRADE-04B is a prerequisite, not an order path.
- Reference signer is for qualification only; production custody is the customer's choice.
- Throughput figures are single-machine diagnostics; the governance path's one-pending-binding-per-
  actor/owner limit (TRADE-03) bounds order flow independently.
- Payment and Trade cannot share an owner account until G1.
- Network binding is configuration, not cryptographic (§11).
- XLS-75 must be enabled on the target network; Mainnet is not representable.

## 28. Operational runbook

| Task | Steps |
|---|---|
| Create a reference key | Linux FS; `FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_KEY_FILE=… node scripts/run-reference-xrpl-offer-signer.mjs create-key xrp-ledger-testnet <owner…>`; keep the file `0600`; pin `<file>.pub` |
| Start the reference signer | set `…_KEY_FILE`, `…_ID`, `…_TOKEN` (≥ 32 chars), optional `…_MAX_FEE`, `…_PORT`, `…_HOST` (literal loopback); `node scripts/run-reference-xrpl-offer-signer.mjs` — it prints public identity only |
| Verify identity | Host client `probe()` → `VERIFIED`; `MISMATCH` means stop and compare the pin |
| `UNAVAILABLE` | check reachability/credential; the next signature re-proves identity automatically |
| `MISMATCH` | do not restart blindly: investigate rotation or tampering; change the pin only after re-qualification |
| Rotate key / credential | §16 / §17 |
| Decommission | owner revokes the delegation on the ledger; delete the key file securely; remove the pin |

## 29. Explicitly deferred components

TRADE-04C (execution composition, gates G2 and G4), TRADE-04D (recovery), TRADE-05 (live
qualification), G1 (shared interlock), Host composition of the client, the Host environment guard for
the reference variables, production custody (HSM/KMS), mTLS transport, ledger re-reads of delegation
and key binding, Testnet accounts and transactions, verifier single-decode optimization.

## 30. Final milestone verdict

Validation (2026-10-14, this WSL2 machine, worktree on `/mnt/c`):

| Check | Result |
|---|---|
| Focused: PAY-02/03, transport, TRADE-04A, TRADE vertical, NO_BYPASS, all `trade04b-*`, G3 preservation | all pass (514 before the final pinned-list fixes; 52/52 for the three suites fixed after) |
| Typecheck, build, lint (Node16 imports, architecture, public surface) | pass |
| Full root suite (`npm run test:root`) | 11 494 tests: 11 479 pass, **2 fail**, 9 skipped, 4 todo (pre-existing `TODO FRONTERA-PROD-01 F1`) |
| — the 2 failures | `external-authority-signer-launcher.test.mjs` (60 s boot deadline under full-suite load on `/mnt/c`; a known environmental failure recorded at TRADE-04A, which passes alone: 20/20 together with `host-preflight.test.mjs`) and one PAY-08 lifecycle case refused `store-freshness-unverified` under load (CORE-07 timing; passes alone, 30/30; it passed in the preceding full run). Neither touches TRADE-04B code. |
| Workspace suites | 235 tests, 0 fail |
| Release coherence (manifest + API freeze) | pass |
| Protocol tarball (CI's steps: pinned commit `eec79cdd`, lock verify, isolated validation) | pass; sha256 `b0d6ee6f…` matches the lock |
| Publishability | pass |
| Benchmark | §22 |

Summary: the protocol, Host-side client,
verifier, transport and reference signer are implemented and qualified offline and over loopback;
G3 is implemented by substitution with Payment equivalence proven; G1, G2 and G4 are untouched.
TRADE-04B cannot execute a governed order, and it claims no production readiness: its safety in use
depends on TRADE-04C placing the signing capability below the bounded grant.

**Verdict: CONDITIONAL** — ready for review as a signing-capability milestone; conditional on
(a) reviewer acceptance of the three approved structural changes (second TRADE composition edge,
EP-073, the SDK-importer list: G3 swap plus one reference process), and (b) TRADE-04C composing it
below the bounded grant before any execution use.
