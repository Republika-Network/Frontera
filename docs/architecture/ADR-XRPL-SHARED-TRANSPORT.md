# ADR: XRPL transport is shared only where it is transaction-neutral and pure; the one XRPL client and the one submit stay where PAY-02 put them; owner-account Sequence safety is one blocking rule plus a fail-closed refusal of shared accounts until a reviewed interlock migration (TRADE-04A)

- Status: accepted for TRADE-04A (phased). The convergence step (§9.3) is **proposed, not approved**.
- Phase: TRADE-04A — Shared XRPL Transport Architecture, Extraction and Sequence Safety
- Baseline: `main @ d04b8b61` (PR #186, TRADE-03 merged; PAY-02 … PAY-08 present)
- Status of implementation: implemented in `src/features/xrpl-transport/` (new, pure);
  the PAY-02 codec and result reader and the PAY-03 SQLite interlock now consume it.
  Qualified by `src/features/xrpl-transport/tests/*.test.ts` and
  `src/enterprise/__tests__/trade04a-*.test.ts`.
- Depends on: `ADR-XRPL-RLUSD-PAYMENT-RAIL.md` (PAY-02, unchanged in meaning),
  `ADR-XRPL-PRODUCTION-COMPOSITION.md` (PAY-03, unchanged),
  `ADR-PAYMENT-SETTLEMENT-RECEIPTS-AND-OBLIGATIONS.md` (PAY-05, unchanged),
  `ADR-AUTHORITY-STATE-FRESHNESS-AND-ROLLBACK-DETECTION.md` (CORE-07, unchanged),
  `docs/integrations/trade/TRADE-00-ARCHITECTURE-FEASIBILITY.md` §6.2 (the original options).
- Canonical documentation: `docs/integrations/trade/TRADE-04A-SHARED-XRPL-TRANSPORT.md`.

> The Payment rail and the Trading rail may share XRPL transport
> infrastructure; they never share transaction-authoring authority.

## 1. Context

TRADE-00 §6.2 recommended a shared, transaction-neutral XRPL transport owning
the SDK client and the only submit call, the codec, network identity and the
restart quarantine, and an account-scoped submission interlock. That
recommendation was written against PAY-03; this ADR re-derives it from the
current source and decides how much of it can be done **safely now**.

Three facts from the code decide the shape:

1. **One submission site, pinned three ways.** The `submit` request is written
   once (`src/features/payment-runtime/rails/xrpl/xrpl-sdk-client.ts:67`), the
   rail calls `client.submit` once (`xrpl-rlusd-rail.ts:430`), and only the
   PAY-03 composition creates the SDK client (`host-composition.ts:128-130`).
   `xrpl-rail-boundaries.test.ts:105-132`, `pay03-xrpl-production-structure.test.ts`
   and `no-bypass-effect-paths.test.ts` (EP-069, "seven outbound sources") all
   pin these file paths. Moving the client is a change to three qualified
   invariants, not a refactor.
2. **The interlock is Payment-shaped and rail-scoped.** The PAY-03 SQLite store
   (`src/enterprise/xrpl-payment-rail/sqlite-xrpl-submission-interlock.ts`)
   binds each file to one `{railId, networkId}` (`:187`, refuses another at
   `:384`), records a Payment `amount` in `NOT NULL` columns (`:202-204`) under
   identity digest domain `…identity.v1` (`:83`), and anchors its reservation
   history at the CORE-07 witness in the single slot
   `xrpl-submission-reservations` (`:158`). Its blocking rule is keyed by
   account (`openBlocking`, `:514`).
3. **A delegated OfferCreate consumes the owner's Sequence.** The delegate
   signs and pays the fee; the **owner's** `Sequence` is checked and consumed
   (TRADE-00 §5, items 11–13, from rippled 3.4.1). So the sequence-relevant key
   for a future trade adapter is the owner account — the same kind of key as a
   Payment source account.

Therefore a future TRADE interlock, written the obvious way (its own file, its
own rail id), would be **blind to every Payment reservation on the same owner
account** — and vice versa. `trade04a-sequence-safety.test.ts` › "C8 hazard,
characterized" proves this on the real store: two interlocks for one account
both answer `reserved` for the same `Sequence`.

## 2. Capability inventory (Phase A, summarized)

The full implementation-level inventory, with blast radius, is
`TRADE-04A-SHARED-XRPL-TRANSPORT.md` §4. Classification:

| Capability | Where today | Class |
|---|---|---|
| Transaction-hash, ledger-hash, ledger-index, signing-key, engine-result grammar | `xrpl-codec.ts`, `xrpl-result-normalizer.ts`, TRADE-02 reader | **SHARED_CANDIDATE → extracted** |
| Network id reading (`readNetworkId`) | `xrpl-result-normalizer.ts` | **extracted** |
| Validated ledger index / header reading | `xrpl-result-normalizer.ts` | **extracted** |
| `submit` answer reading (only `tem…` definitive) | `xrpl-result-normalizer.ts` | **extracted** |
| Blocking rule (open window ∧ sequence ≥ candidate) | `sqlite-xrpl-submission-interlock.ts:514`, `xrpl-rlusd-rail.ts:320-325` | **extracted** (store uses it; rail's in-process copy unchanged) |
| `server_info` validated-ledger evidence, entry binding (regression, hash conflict) | TRADE-02 reader (private) | **SHARED_CANDIDATE → re-implemented in transport**; TRADE-02 unchanged |
| Read-only validated reader with bounded time and size | none | **new** (no real port composed) |
| One-domain-per-sequence-account refusal | none | **new** |
| SDK client construction, connection ownership, `submit` | `xrpl-sdk-client.ts` | **REQUIRES_REDESIGN** (constructor takes the Payment configuration type) → DEFERRED, §7 |
| Autofill reading (`readAutofill`) | normalizer | **REQUIRES_REDESIGN** (special-cases the Payment `Amount` object) → PAYMENT_ONLY for now |
| Signed-blob closure (`signedPaymentMatches`) | codec | **PAYMENT_ONLY** (each closed type owns its field-set closure) |
| Pinned-key signature verification (`signedByPinnedKey`) | codec | **SHARED_CANDIDATE**, DEFERRED: SDK-dependent; moving it adds an SDK importer (§6) |
| Restart quarantine | `xrpl-rlusd-rail.ts:197-218` (closure) + constants in `xrpl-submission-interlock.ts` | **SHARED_CANDIDATE**, DEFERRED to TRADE-04C (no second consumer yet; extraction would edit qualified rail code) |
| Per-account in-process serialization, `unresolved` map | `xrpl-rlusd-rail.ts:226-249` | **PAYMENT_ONLY** (process-local; the durable interlock is the cross-process authority) |
| Lookup reading incl. `delivered_amount` (`readLookup`), finality, P12 | normalizer, `xrpl-finality.ts`, `xrpl-resolution-authority.ts`, `xrpl-finality-authority.ts` | **PAYMENT_ONLY** (a validated `tesSUCCESS` is not a fill) |
| Transaction-neutral inclusion reading (`readXrplInclusion`) | none | **new**, for TRADE-04C/D |
| Signer protocol, external signer, HTTP transport | `src/enterprise/xrpl-payment-rail/` | **PAYMENT_ONLY** (TRADE-04B gets its own protocol) |
| Durable interlock (SQLite, CORE-07 anchored) | `sqlite-xrpl-submission-interlock.ts` | **REQUIRES_REDESIGN** for sharing (§9) |
| OfferCreate builder, delegated signer, offer outcome reading | none | **TRADE_FUTURE** (04B/C/D) |

## 3. Options

**Option A — Fully shared transaction-neutral transport now.** Move the SDK
client, `submit`, codec, quarantine and the interlock into
`src/features/xrpl-transport/`; both verticals use one account-scoped interlock.

**Option B — Separate transports, strict account isolation.** Payment and Trade
each own their transport and interlock; Host configuration forbids an XRPL
account from appearing in both.

**Option C — Shared transport abstraction, phased interlock convergence.**
Extract only what is pure and transaction-neutral now; keep Payment's client,
submit and interlock exactly where they are; enforce Option B's account
isolation as the interim safety rule; converge on one account-scoped sequence
authority only through a qualified, approved migration.

| Criterion | A — fully shared now | B — separate, isolated | **C — phased (chosen)** |
|---|---|---|---|
| Security | One authoring surface risks a generic "submit any blob" API unless carefully gated; signer must stay Payment-only | Strong separation; risk is configuration drift | Shared code is pure; no new authoring or submission surface; isolation enforced |
| Sequence safety | Solved for shared accounts — **only after** the interlock migration lands | Safe only while isolation holds; independent interlocks are blind to each other (C8 hazard) | Same as B now (refused, `assertXrplSequenceOwnership`); same as A after §9.3 |
| Backward compatibility | Breaks pinned paths (SDK importers, submit site, NO_BYPASS sites) and the interlock schema | Untouched for Payment | Payment public names preserved via re-exports; behavior proven identical (`trade04a-payment-preservation.test.ts`) |
| Operational complexity | One store, but a migrated one | Two stores, two CORE-07 slots, two signers; operators must keep accounts disjoint | Today: unchanged. Later: one store |
| Database migration | **Required** (scope rebinding, nullable Payment columns, new identity domain) — not qualified in 04A | None | **None in 04A**; one reviewed migration deferred behind an approval gate |
| Rollback safety | Poor: a v1 binary refuses a v2 file; CORE-07 makes a restored v1 copy `ROLLBACK_DETECTED` (§9.3) | Trivial | Trivial in 04A (no persisted change); §9.3 states the cost of the later step |
| Tests affected | ~6 pinned structural suites change meaning-bearing paths | None | Two classifications, no assertion removed: the rail import allowlist gains exactly one pure module (`xrpl-rail-boundaries.test.ts:95-99`); the new directory is classified out of CORE in PAY-07's manifest and PAY-04 M39 (out of CORE, still scanned, like TRADE) |
| Pilot suitability | Blocks the pilot on a migration | Good: pilot owner accounts are dedicated | Good: pilot runs with dedicated owner accounts, enforced |
| Multi-account market-making throughput | Best long-term (one authority, account-scoped locks) | Fine for disjoint accounts; impossible for Payment + Trade on one account | Same as B now; same as A after convergence |

## 4. Decision

**Option C.** Concretely, in TRADE-04A:

1. **A new pure module, `src/features/xrpl-transport/`**, owning only
   transaction-neutral contracts: the closed protocol grammar; network identity
   (`XRPL_NETWORK_IDENTITIES`, `checkXrplNetworkIdentity`); validated-ledger
   evidence (`readXrplServerValidatedLedger`, `readXrplValidatedLedgerHeader`,
   `bindXrplValidatedAnswer`); a read-only validated reader over a three-method
   read port (`createXrplValidatedLedgerReader`); submission and inclusion
   reading (`readXrplSubmission`, `readXrplInclusion`, `xrplNonInclusionProven`);
   and owner-account Sequence safety (`xrplSequenceWindowBlocks`,
   `assertXrplSequenceOwnership`). It imports only itself — no SDK, no Node
   module, no feature, no enterprise layer (`xrpl-transport-boundaries.test.ts`).
2. **Payment consumes it without changing behavior.** `isXrplTransactionHash`,
   `isXrplSigningPublicKey`, `readSubmission`, `readLedgerIndex`,
   `readLedgerHeader`, `readNetworkId` are re-exported from the shared module
   under their PAY-02/PAY-03 names (the same function objects), and the PAY-03
   store decides with `xrplSequenceWindowBlocks`. The pre-extraction code is
   frozen verbatim in `trade04a-payment-preservation.test.ts` and compared over
   edge-case and generated vectors, plus all 3 × 5 × 5 × 5 × 7 boundary
   combinations of the blocking rule.
3. **The XRPL client, the one `submit` request, the rail, the signer, the
   quarantine and the interlock stay where they are.** No second submit site,
   no SDK importer added, no schema change, no CORE-07 slot added.
4. **Shared owner accounts are refused**, not coordinated, until §9.3 is
   approved and qualified: every (network, account) whose `Sequence` a domain
   consumes belongs to exactly one domain. `trade04a-shared-xrpl-transport-structure.test.ts`
   pins that exactly one sequence-consuming domain (the Payment rail) and one
   interlock are composed today (`host-composition.ts` only); the next
   composition fails that test until it declares itself through
   `assertXrplSequenceOwnership`.

Rejected: Option A now (needs an unqualified breaking migration — the
milestone brief forbids forcing one); Option B as an end state (rules out
Payment + Trade on one account forever and duplicates transport code).

## 5. Answers to the fifteen questions

1. **Already transaction-neutral:** the grammar, network id reading, validated
   ledger index/header reading, `submit` answer reading, the blocking rule, the
   restart quarantine's proof, the SDK client's read methods, and
   `signedByPinnedKey`. The first five are extracted; the rest are deferred (§2).
2. **Payment-specific:** the builder, `XrplPaymentTransaction`, `readAutofill`
   (Payment `Amount`), `signedPaymentMatches` (closure over the prepared
   Payment), `readLookup` / finality (`delivered_amount`), P12 and PAY-05
   authorities, the signer protocol and transport, the interlock's `amount`
   columns and rail-id scope, `settlementOf`.
3. **Safely extractable now:** pure functions with no SDK dependency whose
   behavior is provably identical (§4.2).
4. **Must remain in Payment:** everything in answer 2, and — for now — the SDK
   client, `submit`, quarantine and interlock (pinned, or needing a migration).
5. **The one authorized submission boundary:** `xrpl-sdk-client.ts:67`, reached
   only from `xrpl-rlusd-rail.ts:430` inside EP-069, below the bounded grant.
   TRADE-04A adds none and moves none (SEC-TRADE04A-05).
6. **How TRADE gets validated reads:** through `XrplValidatedLedgerReadPort` and
   `createXrplValidatedLedgerReader` — every read re-proves the network, accepts
   validated answers only, is bounded in time and size, retries nothing. TRADE-02's
   `XrplDelegationLedgerPort` is a raw-answer port of the same shape, so a
   composition edge can satisfy both from one port without TRADE importing
   Payment (`trade04a-validated-read-composition.test.ts`). No real port is
   composed in TRADE-04A.
7. **What protects Sequence allocation:** for Payment, unchanged — per-account
   in-process serialization, the in-process `unresolved` check, and the durable,
   CORE-07-anchored interlock (`BEGIN IMMEDIATE` check-and-insert across
   processes, `:570-597`). Across verticals: the shared blocking rule plus the
   one-domain-per-sequence-account refusal.
8. **Payment and Trade on the same owner account:** refused at composition
   (`XRPL_SEQUENCE_ACCOUNT_SHARED`) until one account-scoped sequence authority
   serves both. The delegate account is not a sequence account (its Sequence is
   untouched) and does not conflict.
9. **How reservations are persisted:** unchanged — PAY-03's SQLite file, one
   immutable row per signed execution written before the one submit,
   forward-only lifecycle by trigger, append-only transition log, reservation
   history anchored at the CORE-07 witness. A future Trade domain on disjoint
   accounts gets its own store and its own CORE-07 slot (TRADE-04C, gated);
   sharing needs §9.3.
10. **Pending and uncertain recovery:** unchanged — an open record (`submitting`
    or `unconfirmed`) blocks until a ledger fact (validated inclusion, `tem`,
    or a complete search after `LastLedgerSequence` validated) or until the
    validated index reaches `LastLedgerSequence`. There is no release
    operation; a failed lookup changes nothing; the same execution is never
    signed or submitted again (`recorded`). P12 resolves `unconfirmed`
    executions from ledger evidence. The shared `readXrplInclusion` /
    `xrplNonInclusionProven` encode the same evidence rule transaction-neutrally.
11. **PAY structural invariants:** every PAY suite runs unchanged except one
    allowlist entry (the rail may import `../../../xrpl-transport/index.js`;
    that module is pure and separately fenced). SDK importers, the submit site,
    the client constructor, the signer's single operation, the Payment-only
    construction and NO_BYPASS counts are unchanged and re-asserted by
    `trade04a-shared-xrpl-transport-structure.test.ts`.
12. **Minimal future interface for OfferCreate:** §8.
13. **Rollback:** revert the TRADE-04A commits. No persisted format, slot,
    configuration or route changed, so a revert restores `d04b8b61` behavior
    exactly; interlock files written before or after are byte-compatible.
14. **What requires migration:** only §9.3 (shared interlock). Nothing in 04A.
15. **Deferred:** to **TRADE-04B** — the delegated signer protocol and its
    verification (§6); to **TRADE-04C** — the OfferCreate adapter, a
    transport-level client configuration and read port over the one SDK client,
    the quarantine extraction, the Trade interlock (disjoint accounts) and its
    CORE-07 slot, Host wiring of `assertXrplSequenceOwnership`, a new EP id if
    a submission is composed; to **TRADE-04D** — offer outcome reading (resting,
    partial, filled, killed) from metadata; to a separate approval —
    §9.3 convergence and moving the submit site (§7).

## 6. Codec and signature boundary

Shared now: hash and signing-key grammar. Deferred: `signedByPinnedKey` is
transaction-neutral but SDK-dependent; moving it would add an SDK importer to
a list PAY-02 pins exactly. It moves in TRADE-04B **by substitution** (the
shared transport gains one codec file that imports the SDK; the PAY-02 codec
then re-exports from it; the importer list is updated by exactly that swap,
never widened), and only with the review that change requires.

Each closed transaction type keeps its own field-set closure. TRADE-04B must
verify, before anything is reserved: exact owner (`Account`), exact delegate
(`Delegate` ≠ `Account`), the exact unsigned OfferCreate the adapter built
(byte-equal signing encoding), no field outside the closed OfferCreate set plus
`SigningPubKey` and `TxnSignature`, `SigningPubKey` equal to the **pinned
delegate key**, a signature that verifies under it, and the blob's own hash.
The Payment parser and signer protocol are not widened (SEC-TRADE04A-02).

## 7. The submission site

It stays in `xrpl-sdk-client.ts`. TRADE-04C needs a submit capability for a
second closed transaction type. The approved shape, **proposed** here:

- the SDK client is reconstructed from a transport-level configuration
  (endpoint, network id, timeouts) instead of `XrplRlusdRailConfiguration`, in
  the **same file** (no new network site);
- the transport exposes no `submit(blob)`. A domain may submit only a
  reservation the sequence authority returned (`reserve` → `reserved`), whose
  hash the transport recomputes from the blob, once;
- the pinned paths in `xrpl-rail-boundaries.test.ts`, `pay03-…-structure` and
  `no-bypass-effect-paths.test.ts` move by substitution, with their meaning
  re-proven (TRADE-00 SEC-TRADE-11: "the test moves, it is not relaxed").

This is approval gate **G2**. Nothing in TRADE-04A prepares a second submit call.

## 8. Minimal future OfferCreate interface (proposed, TRADE-04C)

```ts
// Read side — implemented in 04A.
XrplValidatedLedgerReader.ledgerEntry({ delegate | offer | account_root })   // validated, network-checked, bounded

// Sequence side — the PAY-03 interlock contract, made transaction-neutral (requires §9.3 for shared accounts;
// a Trade-only store on disjoint accounts can implement it without migration).
interface XrplSequenceAuthority {
  recorded(executionId: string): Promise<string | undefined>;
  blocking(q: { networkId: number; account: string; sequence: number; validatedLedgerIndex: number }): Promise<boolean>;
  reserve(r: { executionId: string; domainId: string; transactionKind: 'Payment' | 'OfferCreate';
               account: string; sequence: number; lastLedgerSequence: number; minLedger: number;
               transactionHash: string; detailsDigest: string }, validatedLedgerIndex: number): Promise<XrplSubmissionReservation>;
  markUnconfirmed(executionId: string, transactionHash: string): Promise<void>;
  settle(executionId: string, transactionHash: string, settlement: XrplInterlockSettlement): Promise<void>;
}

// Order, unchanged from PAY-03:
// build (closed OfferCreate) → network check → validated index + LLS → autofill (Sequence/Fee only)
// → fee ceiling → blocking? → delegate sign (TRADE-04B) → verify (exact, pinned delegate key, own hash)
// → reserve (durable, witnessed) → submit ONCE → reconcile (validated inclusion / proven non-inclusion)
```

## 9. Sequence ownership and the interlock

### 9.1 The rule (implemented)

`xrplSequenceWindowBlocks(window, S, V) = window.open ∧ window.LLS > V ∧ window.sequence ≥ S`,
fail-closed (only `open: false` releases; incomparable numbers block). The
PAY-03 store applies exactly this after its SQL window filter (`:514`).

### 9.2 Interim (implemented)

`assertXrplSequenceOwnership(domains)`: refuses any (network, account) named by
two domains; domains are keyed by their **sequence-consuming** accounts
(Payment sources; delegated-trade owners). It must run over **all** XRPL
submission domains, before any interlock is opened, in the composition that
creates the second one (TRADE-04C, enforced by the structural tripwire).

### 9.3 Convergence (proposed — approval gate G1, not implemented)

One durable sequence authority keyed by `{networkId, account}` serving every
domain. On the PAY-03 store this means: schema `…schema.v2`; scope rebound
from `{railId, networkId}` to `{networkId}` (the scope row is immutable by
trigger, so a new scope table); a `transaction_kind` and `domain_id` per row;
Payment `amount` moved to a kind-specific details record (the `NOT NULL`
columns force a table rebuild); v1 rows kept verifiable under `…identity.v1`,
new rows under `…identity.v2`; the CORE-07 reservation chain continued
unchanged (identity digests are copied verbatim, so the head digest does not
move).

Exact safety impact: (a) a v1 binary refuses a v2 file (version guard), so
after the first v2 reservation **rollback is roll-forward only**; restoring
the pre-migration copy is `ROLLBACK_DETECTED` at the witness, by design;
(b) the rebuild runs under `BEGIN IMMEDIATE` with the Host stopped and every
recorded window closed or carried forward; (c) it needs historical-fixture,
crash-consistency (kill at each step), tamper and stale-restore tests, and
proof that Payment's decisions are unchanged on migrated files. None of that
is in TRADE-04A.

## 10. Consequences

- TRADE-02's verifier can be composed over a transport port without importing
  Payment; no production read port exists yet.
- Payment and Trade cannot run on one owner account until G1. Pilots use
  dedicated owner accounts.
- The transport is outside the PAY-07 qualified CORE (classified in
  `pay07-core-source-manifest.ts`), like the rails it serves.
- NO_BYPASS: no number changed (eleven of seventy-two after PAY-09, merged from `main`; ten of seventy-one at the baseline).

## 11. Approval gates

| Gate | Change | Status |
|---|---|---|
| G1 | Shared account-scoped interlock (schema v2 migration, §9.3) | Not requested in 04A; needs explicit approval and its own qualification |
| G2 | Moving or reconstructing the one submit site for a second transaction type (§7) | Not requested in 04A |
| G3 | Moving `signedByPinnedKey` (adds an SDK importer by substitution, §6) | TRADE-04B — **implemented** under the user's narrow authorization (§12) |
| G4 | First Trade sequence domain composition: new CORE-07 slot, EP id, Host wiring of `assertXrplSequenceOwnership` | TRADE-04C |

## 12. Addendum — G3 implemented (TRADE-04B)

Recorded by TRADE-04B (`docs/integrations/trade/TRADE-04B-PROTECTED-DELEGATED-SIGNER.md` §7, §21);
the TRADE-04A text above is left as it was decided.

- **What moved, by substitution.** `src/features/xrpl-transport/xrpl-signature.ts` is the one
  transport file that imports the SDK — exactly `decode`, `encode`, `encodeForSigning`, `hashes`,
  `verifySignature` and the `Transaction` type, pinned verbatim. It exports six total,
  synchronous questions about bytes: `isXrplSignedBlob`, `decodeXrplSignedBlob`,
  `xrplSingleSigningEncoding`, `isCanonicalXrplSignedBlob`, `xrplSignedBlobHash` and
  `signedByPinnedKey` (moved verbatim but for its parameter name). It signs nothing, holds no
  key, opens nothing, names no transaction type, and is **not** on the transport's barrel, so
  consumers of the pure transport do not load the SDK.
- **Payment unchanged.** The PAY-02 codec no longer imports the SDK; it reaches these
  primitives through that file and re-exports `signedByPinnedKey` as the same function object.
  `signedPaymentMatches` — Payment's own field-set closure — is unchanged in meaning; the
  pre-move implementations are frozen in
  `src/features/payment-runtime/rails/xrpl/tests/xrpl-codec-signature-preservation.test.ts` and
  compared with the shipped ones over real signed Payments (both key algorithms), every single-field
  tamper, foreign keys, multisigned blobs, transplanted signatures, malformed input and a
  throwing prepared payment. The Payment parser, signer protocol and signer service are untouched.
- **Importer list.** PAY-02's repository-wide SDK-importer list swapped `xrpl-codec.ts` for
  `xrpl-signature.ts`. Separately, and by its own approval, TRADE-04B added one reference
  process importer (`src/enterprise/xrpl-trade-rail/reference/reference-delegated-offer-signer.ts`),
  beside PAY-03's. Production importers: five.
- **Structural tests, same meaning.** `xrpl-transport-boundaries.test.ts` keeps every rule for
  every other transport file; the signature file is held to the same rules with one narrowing —
  it may *verify* (`encodeForSigning`, `verifySignature`), never sign — and its import statement
  and exports are pinned; negative fixtures prove the exception is exact.
- **Each closed type keeps its own closure.** The delegated OfferCreate verifier
  (`src/enterprise/xrpl-trade-rail/delegated-offer-verification.ts`) applies §6's list on top of
  these primitives, plus a canonical-serialization check.

G1, G2 and G4 remain unapproved and unimplemented.
