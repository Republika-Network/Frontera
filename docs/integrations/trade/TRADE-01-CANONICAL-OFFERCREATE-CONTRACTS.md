# TRADE-01 — Canonical Trading Domain & Governed OfferCreate Compiler

> **A trading proposal is applicant intent, never a fact.** It compiles down to
> the generic governed-action envelope and is decided on the unchanged governed
> path. Nothing in TRADE-01 signs, submits, reads a ledger or executes.

- Status: implemented — `src/features/trade-runtime/` (contract and compiler only).
- Builds on: TRADE-00 (`docs/integrations/trade/TRADE-00-ARCHITECTURE-FEASIBILITY.md`, commit `bdcd256`).
- Branch: `feat/trade-01-offercreate-contracts`, based on `bdcd256`.
- CORE, PAY, signer protocols, interlocks, registries, production configuration and the website: **unchanged**.

---

## 1. Implementation overview

TRADE-01 delivers five things:

1. A closed, typed `TradeProposal`: one XRP Ledger OfferCreate that an automated trading engine asks Frontera to authorize.
2. Exact assets and amounts:
   - XRP is carried as integer drops.
   - Issued values are canonical decimal text, held to the ledger's exact representability.
   - No JavaScript number ever represents money.
3. An exact limit price: a reduced `BigInt` fraction (quote per base), derived from the two amounts and never stated independently.
4. A deterministic canonical form and a domain-separated `sha256` digest over the accepted canonical proposal.
5. A pure compiler onto the existing `GovernedActionIntent`. It uses existing CORE-03 extension points only: declared parameter dimensions, a profile parameter list, and configured reserved context keys.

A mandatory spike (§8) characterized, with executable tests, what CORE can and cannot compare exactly. The design avoids every comparison CORE cannot do.

## 2. Exact source paths

| Path | Responsibility |
|---|---|
| `src/features/trade-runtime/index.ts` | Module entry; re-exports the domain |
| `src/features/trade-runtime/domain/trade-grammar.ts` | Networks (Testnet/Devnet only), identifiers, classic-address base58check, currency codes, closed-record snapshot |
| `src/features/trade-runtime/domain/trade-asset.ts` | XRP/issued amounts, ledger representability, exact quantities, asset tokens, P9 asset ids |
| `src/features/trade-runtime/domain/trade-price.ts` | Exact rational limit price, comparison, price assertion parsing |
| `src/features/trade-runtime/domain/trade-proposal.ts` | The closed proposal, validation, derived terms, replay/conflict classification |
| `src/features/trade-runtime/domain/trade-canonical.ts` | Canonical serialization and the domain-separated digest |
| `src/features/trade-runtime/domain/trade-governance.ts` | Dimensions, profile parameters, reserved keys, binding, compiler |
| `src/features/trade-runtime/domain/index.ts` | Explicit exports |
| `src/features/trade-runtime/tests/trade-proposal.test.ts` | Proposal, direction, money, assets, allowlist, canonicalization (unit) |
| `src/features/trade-runtime/tests/trade-governance.test.ts` | Compiler mapping and refusals (unit) |
| `src/features/trade-runtime/tests/trade-policy-comparison-spike.test.ts` | The §8 spike, as characterization of current CORE behaviour |
| `src/features/trade-runtime/tests/trade-runtime-boundaries.test.ts` | Structural boundaries (§11) |
| `src/enterprise/__tests__/trade01-governed-offer-create.test.ts` | The unchanged envelope validator accepts the compiled intent |

The module follows the PAY-01 layout and conventions: a domain folder, explicit index exports, a `node:test` boundary test, and an enterprise-level compatibility test. There is no `services/` folder because the compiler is pure domain logic, as `compilePaymentIntent` is.

## 3. Proposal schema

`schema: 'frontera.trade-proposal.v1'`. The schema is closed: every other property is refused with a reason (§11).

| Field | Required | Type and rule |
|---|---|---|
| `schema` | yes | exactly `frontera.trade-proposal.v1`; any other value gives `SCHEMA_UNSUPPORTED` |
| `organizationId`, `principalId`, `requestId`, `idempotencyKey` | yes | governed token (`[A-Za-z0-9][A-Za-z0-9._:@-]*`, ≤128), never credential-shaped |
| `network` | yes | `xrp-ledger-testnet` (network id 1) or `xrp-ledger-devnet` (2). **Mainnet is not representable** |
| `ownerAccount` | yes | classic address, base58check verified; reserved accounts (ids 0 and 1) refused |
| `delegateAccount` | yes | as above, and ≠ `ownerAccount` (the ledger also refuses this, with `temBAD_SIGNER`) |
| `permission` | yes | exactly `OfferCreate` |
| `takerGets` | yes | amount the **owner gives up** (§4) |
| `takerPays` | yes | amount the **owner wants to receive** (§4) |
| `requestedValiditySeconds` | yes | safe integer 1…3600 (the Host grant ceiling) |
| `flags` | no | array of distinct names from `passive`, `immediate-or-cancel`, `fill-or-kill`, `sell`; IOC with FOK is refused |
| `expiration` | no | OfferCreate `Expiration`, Ripple-epoch seconds, 1…2³²−1 |
| `referenceContextId`, `policyContextRef` | no | applicant references (tokens); **never facts** |
| `pair`, `side`, `limitPrice` | no | **assertions only**: checked against what the amounts imply, then dropped |

Fields that are deliberately **excluded**, and refused with `EXECUTION_FIELD_REFUSED` (matched case-insensitively):
- `TransactionType`, `Account`, `Delegate`;
- `Fee`, `Sequence`, `TicketSequence`, `LastLedgerSequence`;
- `SigningPubKey`, `TxnSignature`, `Signers`, `Memos`;
- raw `Flags`, `OfferSequence`, `DomainID`, `NetworkID`, `SourceTag`, `AccountTxnID`;
- raw `Expiration`, raw `TakerGets`/`TakerPays`;
- `tx_json`, `tx_blob`, `transaction`, `signedTransaction`, `signature`, `hash`.

Sequence, fee and ledger validity are the future trusted execution adapter's responsibility. A caller cannot inject a raw transaction.

**Canonical form.** It has the same shape as the input, and the canonical proposal validates to itself:
- Assertions are removed.
- `flags` is always present, sorted by ledger bit, and empty when none is requested.
- Absent optional fields are absent: never `null` and never a default. A key present with `undefined` reads as absent; `null` is refused.

**Derived terms** (`TradeOrderTerms`) are not part of the digest:
- canonical `base` and `quote`;
- `side`;
- `quantity` (base units) and `counterQuantity` (quote units);
- exact `limitPrice`;
- the OfferCreate `flagsValue`.

## 4. Asset and amount semantics

**OfferCreate direction.** These are the ledger's own semantics:
- `takerGets` is what the offer's owner **gives**.
- `takerPays` is what the owner **receives**.

The names describe the counterparty's view. They are never reinterpreted.

| Asset | Form | Rules |
|---|---|---|
| XRP | `{ currency: 'XRP', drops }` | positive integer text, no leading zero, ≤ 10¹⁷ (total supply); a fractional drop gives `AMOUNT_PRECISION_EXCEEDED`; an issuer gives `ISSUER_NOT_ALLOWED_FOR_XRP` |
| Issued | `{ currency, issuer, value }` | see the rules below this table |

Rules for an issued amount:
- **Currency:** a 3-character `[A-Za-z0-9]` code, kept case-sensitively as on the ledger, or a 40-hex code, upper-cased.
- **Refused currencies:**
  - `XRP` in any case;
  - a hex code starting `00`, which is the ledger's encoding of a 3-character code or of XRP (refusing it prevents two spellings of one currency).
- **Issuer:** a valid, non-reserved classic address.
- **Value:** canonical decimal text, with at most 16 significant digits and a normalized exponent in −96…80, so the ledger never rounds it.

Normalization only drops trailing fractional zeros (P9's `canonicalizeDecimalText`). Everything else is refused, never repaired:
- leading zeros, `+` or `-`, exponents, whitespace;
- locale separators, `NaN`/`Infinity`, numbers, and text longer than 256 characters.

Two more rules:
- `XRP ↔ XRP` is refused (`XRP_FOR_XRP`).
- The same issued asset on both sides is refused (`SAME_ASSET`), including a hex code spelled in two cases. The same currency from two different issuers is two assets and may trade.

**Canonical pair orientation:**
- XRP, when present, is the quote.
- Otherwise the asset whose token (`<currency>.<issuer>`) sorts first, in code-unit order, is the base. This is deterministic, not a market convention; an approved-pair configuration may choose orientation in TRADE-03 (§13).

**Side:** `sell` when the owner gives the base, `buy` when it gives the quote.

**Governed asset identity** (for P9):
- XRP: `<network>:XRP`.
- Issued: `<network>:<currency>/<issuer>`.

A Testnet asset and a Devnet asset are different assets. Whether an asset is recognized, and at what scale, remains the host's P9 registry's decision.

## 5. Limit-price representation

`TradePrice = { numerator: bigint, denominator: bigint }`:
- It is reduced by GCD, and both parts are positive.
- It is always **quote per one base unit**, with XRP counted in XRP.
- It is computed exactly as `(q·10^bs) / (b·10^qs)` from the two exact quantities.
- Its text form is `<n>/<d>`. Comparison is cross-multiplication.

Meaning:
- For a `sell`, the price is the **lowest** acceptable price.
- For a `buy`, it is the **highest** price the owner will pay.

`0.1 XRP for 0.3 USD` and `1 XRP for 3 USD` both give exactly `1/3`; no decimal approximation is ever formed.

An asserted `limitPrice {numerator, denominator}` may be unreduced. It must equal the derived price, otherwise `PRICE_CONTRADICTS_AMOUNTS`. Malformed parts (zero, sign, fraction, leading zero, more than 256 digits, numbers) give `PRICE_MALFORMED`.

**A limit price is not slippage protection.** It bounds the worst execution rate. It says nothing about fairness against the market at application time. That needs a trusted reference price (§10), never the applicant's.

## 6. Canonicalization and hashing

- **Input to the digest:** the accepted canonical proposal only, never caller JSON.
- **Serialization:**
  - object keys in code-unit order;
  - no whitespace;
  - `JSON.stringify` strings;
  - safe integers only;
  - arrays in canonical order.
- **Digest:** `sha256:<hex>` of `frontera.trade-proposal-digest.v1\n` followed by the canonical bytes. The domain tag means the digest can never be confused with another digest of the same bytes.
- **Bound into the digest:**
  - schema version;
  - organization, principal, request id and idempotency key;
  - network;
  - owner, delegate and permission;
  - both exact amounts;
  - flags, expiration, requested validity;
  - both applicant references.
- **No secrets:** no secret is ever in the proposal. Secret-shaped properties are refused without being read.
- **Equal meaning gives an equal digest:** decimal spelling, hex case, key order, flag order, absent vs empty flags, and agreeing assertions all produce the same digest.
- **Different meaning gives a different digest:** every bound field is tested individually, and swapping the two amounts is tested too.
- **Not authority:** the digest is an integrity and correlation primitive only. It is not a signature, a grant or proof of authority.

`classifyTradeProposalReplay` classifies a pair of proposals:
- `replay`: same organization, principal and idempotency key, same digest.
- `conflict`: same organization, principal and idempotency key, a **different** digest.
- `distinct`: otherwise.

This is the same rule the governed path applies.

## 7. Governed-action compilation

`compileTradeProposal(raw, binding, identity, envelope?)` takes:
- `binding = {action}`: trusted wiring-time configuration (`createTradeGovernanceBinding`);
- `identity = {organizationId, principalId}`: the authenticated identity, never the proposal's.

It validates the proposal and refuses `ORGANIZATION_MISMATCH` or `PRINCIPAL_MISMATCH` before anything is evaluated. It then emits the following mapping.

| Proposal | Envelope | Governed axis |
|---|---|---|
| `binding.action` | `action` | Kernel `action.type`, grant action bound |
| `network:ownerAccount` | `resource` | resourceScope, grant resource set; resource class via profile config |
| `takerGets` (in its unit) | `amount {value, currency: <network>:<asset>}` | P9 exact amount, P10 ceilings, P7 exposure |
| canonical digest | `parameters.tradeProposalDigest` | CORE-03 token, **exact** — binds the whole order |
| `network` | `parameters.tradeNetwork` | token, exact |
| `delegateAccount` | `parameters.tradeDelegateAccount` | token, exact |
| derived base / quote | `parameters.tradeBaseAsset` / `tradeQuoteAsset` | tokens, exact |
| derived side | `parameters.tradeSide` | token, exact |
| derived base quantity | `parameters.tradeQuantity` | token, exact (canonical decimal text) |
| `idempotencyKey` | `idempotencyKey` | replay / conflict on the governed path |
| `requestId` | `correlationId` | correlation |
| `organizationId`, `principalId` | not emitted | checked against the bound identity; the envelope refuses them anyway |

Three more properties of the output:
- **No asserted context.** The compiler emits no `assertedContext`. A trading engine therefore cannot use compilation to state a reference price, an exposure, a delegation status or an approval.
- **Optional profile pin.** The only envelope option is `expectedGovernanceProfile` (a pin, validated exactly). Anything else gives `ENVELOPE_OPTIONS_INVALID`.
- **Pure and deterministic.** The output is frozen. The compiler makes no network, signer, adapter or clock call.

**Host composition** uses existing configuration only:
- `TRADE_PARAMETER_DIMENSIONS` in `governance.parameterDimensions`;
- a profile with `TRADE_PROFILE_PARAMETERS`, where all dimensions are required;
- the action listed in `monetary.financialActions`;
- the assets in the P9 registry;
- `TRADE_RESERVED_CONTEXT_KEYS` in `governance.reservedContextKeys`. These are configured keys, **not** additions to CORE's built-in `GOVERNED_ACTION_RESERVED_CONTEXT_KEYS`.

`trade01-governed-offer-create.test.ts` proves that the unchanged `validateGovernedActionIntent` accepts the compiled intent as a financial, semantically classified action with seven exact parameters. It also refuses:
- tampered or extended parameters;
- unregistered assets;
- over-scale values;
- unclassified owners;
- reserved context keys.

**Trust classes kept apart:**

| Class | Where it lives |
|---|---|
| Applicant-supplied economic intent | the proposal, its digest, the seven parameters |
| Trusted context (reference price, live exposure, active-order count, attested delegation) | **CORE-04 sources only**; none exist yet (TRADE-03) |
| Policy configuration | profiles, policy packs, P7/P10 authority state |
| Execution-time ledger facts (Sequence, fee, LLS, delegation entry at signing, validated result) | the future execution adapter (TRADE-04) |

## 8. Policy comparison spike — results

**Question:** can existing governance semantics express exact or maximum bounds for monetary trading values without floating point?

**Evidence:** `trade-policy-comparison-spike.test.ts` pins the shipped behaviour of:
- `governed-parameter-runtime` (`parameter-value.ts`, `parameter-bound.ts`);
- `domain-policy-pack-runtime` (`policy-pack-validator.ts` l.249–255 and l.283–292, and `policy-condition-evaluator.ts` `compareOrdered`, l.229–237);
- P9 `canonical-decimal.ts`.

No CORE file was changed.

| Question | Finding |
|---|---|
| A. How are integer bounds represented and compared? | `exact` or `maximum` (integers only), over JavaScript **safe integers**, compared numerically. Tokens are `exact` only. |
| B. Are arbitrarily large integers supported? | **No.** `> 2^53−1` is refused (`PARAMETER_INTEGER_NOT_SAFE`). 10¹⁷ drops does not fit, and issued values (up to 10⁹⁶, down to 10⁻⁸¹) cannot be integers at all. |
| C. Is decimal text rejected, tokenized or compared? | It is accepted only as an **opaque token**. The token grammar also admits `1e5`, so only TRADE validation guarantees canonical decimal text. A **literal** ordered threshold on a parameter must be a safe integer (`INVALID_PARAMETER_THRESHOLD`). A parameter ordered against an **admitted context fact** (`valueFrom`) **is** admitted, and compared exactly with `BigInt` when both sides are canonical decimal text. A mismatch of kinds never matches. |
| D. Is a fixed-scale integer suitable for size and notional limits? | Only inside the safe range (≈9.007·10⁹ XRP at drop scale), and only with a trusted per-asset scale. It cannot represent the ledger's full range. **Not adopted.** |
| E. Can exact rational comparisons stay within TRADE without changing CORE? | **Not through CORE policy.** CORE has no rational type, and `/` is outside the token grammar. A rational can only be **pinned exactly** (it is inside the digest). Ordered price checks need a TRADE-specific evaluation step (§10). |
| F. Can the envelope bind the full canonical proposal? | **Yes.** Through an `exact` token dimension carrying the domain-separated digest (`tradeProposalDigest`), validated by the unchanged envelope. |

**Additional verified hazard.** The evaluator's ordered comparison fails *closed to "no match"*. A **deny**-shaped rule ("deny when quantity > limit") therefore **fails open** in three cases:
- when the fact is not admitted;
- when the token is not canonical;
- when kinds differ (decimal text against an integer fact).

TRADE policy (TRADE-03) must state limits as conditions that must hold, with the fact required, and must not rely on a deny-when-greater rule alone. Whether profile `materialFacts` makes a missing fact block the decision is to be verified in TRADE-03.

**Recommended representation (adopted):**
- **Governed leg (`takerGets`):** the P9 `amount`, exact canonical decimal text. CORE already enforces ordered limits on it with literal decimal thresholds (P9 policy `amount` predicates, `BigInt`) and P10 `max_amount` ceilings.
- **Base quantity:** an `exact` decimal-text token. It is orderable **only** against admitted canonical-decimal facts (`valueFrom`).
- **Limit price:** an exact rational, bound only through the digest.
- **Nothing is ever a JavaScript number.**

## 9. Existing CORE functionality reused

| Reused | How |
|---|---|
| `GovernedActionIntent` and `validateGovernedActionIntent` (`src/enterprise/governed-action/`) | Compilation target; proven by the enterprise test |
| CORE-03 parameter dimensions, profiles and reserved keys (`governed-parameter-runtime`, `governance-profile`) | `TRADE_PARAMETER_DIMENSIONS`, `TRADE_PROFILE_PARAMETERS`, `TRADE_RESERVED_CONTEXT_KEYS` as host configuration |
| P9 canonical decimal (`monetary-runtime/canonical-decimal.ts`) | `canonicalizeDecimalText` is the single normalization; the governed amount is P9's |
| Execution-runtime `isRecordableProviderRef` | No identifier may be credential-shaped |
| Governed token grammar | Identifiers, references and every emitted parameter |
| P10, P7, CORE-04, CORE-05, P4, grants, P11/P12 | Untouched. They apply to the compiled action exactly as to any governed action once a host composes it |

## 10. Unsupported and deferred controls

| Control | Status after TRADE-01 |
|---|---|
| Max amount per order (governed leg) | Expressible in CORE: P10 `max_amount`, P9 `amount` predicates with decimal literals |
| Approved pairs / issuers / delegate | Expressible as policy `equals`/`in` over the exact tokens `tradeBaseAsset`, `tradeQuoteAsset`, `tradeDelegateAccount` (TRADE-03 to configure and test) |
| Base-quantity bounds | Only against an **admitted** canonical-decimal fact (`valueFrom`); a literal threshold is **unsupported by CORE** |
| Absolute limit-price bounds | **Unsupported by CORE**: no rational type or ordering. Proposed: a TRADE-specific, pure evaluator that compares `TradePrice` against operator-configured bounds and emits its result as an attested fact through a CORE-04 source (TRADE-03) |
| Reference-price deviation, notional in a reference unit | Needs a trusted price source (CORE-04) plus TRADE arithmetic; deferred |
| Aggregate exposure, max active orders | Need ledger-attested state; deferred (TRADE-03/07) |
| Delegation authorization on the ledger | Checked by the execution side at signing time (TRADE-02/04), never asserted by the applicant |
| Second leg (`takerPays`) as money | Not a P9 amount (one amount per envelope); bound exactly via the digest; deferred |
| Policy-pack version binding in the grant | Not bound by CORE (TRADE-00 §19). Unchanged; deferred to ADR |
| `OfferCancel`, `OfferSequence` replacement, `DomainID` / hybrid offers, tickets | Excluded by the closed schema |
| Mainnet | Not representable |

**Shared change deferred for architectural review.** `src/enterprise/__tests__/pay04-payment-protocol-structure.test.ts` (M39, "the core files naming XRPL are exactly …") counts every `src/features/*` module except `payment-runtime` as CORE, and pins the exact list of files naming the four-letter XRP Ledger token.
- TRADE-01 respects it unchanged. Its production sources spell the venue "XRP Ledger" and use `xrp-ledger-*` network ids.
- `trade-runtime-boundaries.test.ts` asserts this, so the PAY-04 list stays exact.
- TRADE-02 onward will need ledger-specific vocabulary. The test should then recognize `trade-runtime` as a vertical, as it does `payment-runtime`. That is a shared security-test change and needs explicit review. It is **not** made here.

## 11. Security boundaries

Enforced by `trade-runtime-boundaries.test.ts`, over production sources with comments stripped:

| Boundary | Rule |
|---|---|
| Imports | Only `./`, `../domain/`, `execution-runtime`, `monetary-runtime`, `governed-parameter-runtime` index, and `crypto` |
| `crypto` | `createHash` only (digest and address checksum). No key, signature or randomness |
| Ledger SDK and network | No ledger SDK or codec import (SDK, binary codec and related packages), no `new Client(`, no submit or autofill, no `fetch`/HTTP/socket/`fs` |
| Custody | No signing, key derivation, wallet or seed handling |
| Execution | No adapter, grant issuance or exercise, policy evaluation or orchestrator; no second governed-action path |
| Purity | No clock, no randomness, no `parseFloat`/`toFixed`/`Math.round`-family; `Number()` only for a byte in base58 decoding |
| Isolation | Nothing in Frontera (production) imports `trade-runtime`; no composition edge exists yet |

Validation also enforces the following:
- **Closed records everywhere.** `__proto__`, `constructor` and `prototype` keys are refused, as are symbols and accessors (which are never run) and non-plain objects.
- **Secret-shaped names** are refused without reading the value.
- **Errors carry codes and field names, never values.**
- **Isolation:** cross-organization and cross-principal mismatches are refused at compilation, and identity is never taken from the proposal.
- **No mainnet:** mainnet is not representable (SEC-TRADE-09).
- **Address validation:** the base58check decoder was cross-checked against the installed `ripple-address-codec`. A scratch script, not committed, compared 5,000 random valid addresses and 5,000 single-character corruptions with zero disagreement. The repository imports no SDK from TRADE.

PAY-02/PAY-03 boundaries are not modified. The XRPL rail, signer protocol, interlock, CORE grant semantics and policy comparison logic have no diff.

## 12. Test matrix and results

Every row was executed on 2026-10-12 against this branch.

| # | Requirement | Test |
|---|---|---|
| 1 | Valid canonical proposal | `trade-proposal` "(1) accepts a complete proposal…", "validates to itself" |
| 2 | Invalid network | "(2) refuses any network other than…" |
| 3, 4 | Invalid owner / delegate | "(3)(4)…" (malformed, checksum, X-address, reserved) |
| 5 | Owner = delegate | "(5)…" `OWNER_IS_DELEGATE` |
| 6 | Invalid currency | "(6)…" (lengths, `XRP` spellings, `00` hex, non-hex) |
| 7, 8 | Missing / invalid issuer | "(7)…(8)…" |
| 9, 10 | XRP-for-XRP / same asset | "(9)…(10)…" |
| 11, 12 | Zero / negative | "(11)…(12)…" |
| 13 | Excess precision | "(13)…" (17 significant digits, fractional drops) |
| 14 | Overflow | "(14)…" (exponent range, supply, 300-digit text) |
| 15 | Scientific notation | "(15)…" |
| 16 | Invalid rational price | "(16)…" |
| 17 | Contradictory direction | "(17)…" |
| 18 | Unsupported flags | "(18)…" |
| 19 | Injected transaction fields | "(19)…" |
| 20 | Request identity collision | "(20)…" replay / conflict / distinct |
| 21 | Equivalent inputs | "(21)…" |
| 22 | Different economics → different digest | "(22)…" (17 single-field variants plus swap) |
| 23 | Trusted-context claims | "(23)…" (proposal) plus "emits no asserted context" (compiler) plus reserved keys (enterprise) |
| 24 | Cross-organization mismatch | `trade-governance` "(24)…" |
| 25 | Missing or invalid mandatory fields | "(25)…" |
| 26 | Unknown schema version | "(26)…" |
| 27 | Prototype pollution / dangerous keys | "(27)…" (top-level and nested `__proto__`, symbols, class instances) |
| 28 | Determinism | "(28)…" |
| — | XRP→token, token→XRP, token→token, buy/sell, reversed pair, exact price | `trade-proposal` direction suite |
| — | Envelope compatibility | `trade01-governed-offer-create.test.ts` |
| — | Cannot sign, submit, construct a client, access seeds, execute, or open a second path | `trade-runtime-boundaries.test.ts` |
| — | Spike A–F | `trade-policy-comparison-spike.test.ts` |

**Results** (executed 2026-10-12, WSL2, Node v22.23.1):

- **TRADE-01 tests:** 67 tests (four feature suites and the enterprise suite), **67 pass, 0 fail**.
- **Static checks:** `npm run typecheck`, `npm run build` and `npm run lint` all pass.
- **`npm run test:workspaces`:** 34 suites, all pass.
- **Root suite (`node --test`), 10 315 tests**, run three times with TRADE-01 present. Each run had exactly **one** failure, always in a pre-existing, wall-clock-based CORE test:

  | Run | Failing test |
  |---|---|
  | 1 | CORE-06 §11 T7 (`core06-governance-core-qualification-host.test.ts`: waits ~6 s of real time for a context-capped grant to expire) |
  | 2 | CORE-06 §11 T7 |
  | 3 | T7 **passed**. Instead `exercise-control-sqlite.test.ts` "a real write-lock wait" failed, reporting a **negative** elapsed time ("waited −1585 ms of 600") |

  That SQLite test also failed **once in three isolated runs**, with no TRADE file involved. A negative elapsed time means the wall clock stepped backwards (WSL2 clock resynchronization). The same step explains T7: it waits only 250 ms past expiry, so a backwards step larger than that leaves the grant genuinely unexpired at exercise.

  The CORE expiry check itself is correct (`grant-exercise-assessment.ts:136`, `now >= expiry`). Classification: **environmental (unstable wall clock) failures of existing timing tests, not regressions**. TRADE-01 modifies no tracked file, and no production code imports `trade-runtime`.

  For comparison, one baseline run without TRADE-01 (10 248 tests) and one run without the TRADE boundary test (10 306 tests) each had 0 failures. That is consistent with an intermittent cause, not a deterministic one.

  **Recommendation (outside TRADE-01 scope):** make these CORE timing tests use an injected or monotonic clock, or a larger expiry margin, so a host clock step cannot flip them.

## 13. Remaining work for TRADE-02

1. **Delegation observation contract.** Define `DelegationObservation`: network id, validated ledger index and hash, owner, delegate, the Delegate keylet (`SHA-512Half(0x0045‖owner‖delegate)`), the permission list and `PreviousTxnID`. Add a pure verifier that requires `OfferCreate` (value 8) and rejects stale observations. Use keylet test vectors.
2. **Read-only ledger reader port.** Fake-ledger tests only; no live network in CI.
3. **Architectural review item.** Decide how `trade-runtime` is recognized as a vertical by the PAY-04 M39 vocabulary test (§10) before ledger-specific vocabulary lands.
4. **Spike follow-ups for TRADE-03:**
   - whether profile `materialFacts` makes a missing price/limit fact block the decision;
   - the TRADE-specific rational price evaluator design (pure, emitting an attested fact).
5. **Keep TRADE-02 additive.** No shared registry, CORE-07 slot, NO_BYPASS numbering or Master Plan edits until PAY-06 merges (TRADE-00 §17).
