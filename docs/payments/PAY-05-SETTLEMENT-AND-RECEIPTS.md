# PAY-05 — Settlement, Receipt & Payment Obligation Semantics

> **"Settled" means funds finality with evidence.** A governed payment is
> `settled` only when a trusted finality authority has established, from the
> rail itself, that exactly that payment's funds transfer is final, and
> bounded evidence of why is durably recorded. It is distinct from P11's
> provider confirmation, from P12's execution resolution and from P7's
> capacity settlement.

- Status: implemented — `src/features/payment-runtime/domain/payment-settlement.ts`,
  `payment-refund.ts` (rail-neutral contract), `src/enterprise/payment-settlement/`
  (embedder composition edge), `src/features/payment-runtime/rails/xrpl/xrpl-finality.ts`
  and `src/enterprise/xrpl-payment-rail/xrpl-finality-authority.ts` (XRPL reference implementation)
- Decision record: `docs/architecture/ADR-PAYMENT-SETTLEMENT-RECEIPTS-AND-OBLIGATIONS.md`
- Master plan: PAY-05 (former P15)
- Invariants: SEC-INV-250 … SEC-INV-262 · Threat model: §7.31

## 1. Four facts that are not one another

| fact | owner | question it answers | what it is **not** |
| --- | --- | --- | --- |
| `confirmed-completed` | P11 (`execution-outcome-store`) | did the provider confirm the instruction completed? | settlement, finality, a receipt, irrevocability |
| `resolved / confirmed-completed` | P12 (`execution-resolution-store`) | did the uncertain effect definitively complete? | settlement, finality |
| reservation `settled` / `released` / `reconciled` | P7 (`exercise-control`) | does the capacity a reservation took stay consumed? — **capacity settlement** | funds settlement of any kind |
| interlock `settle()` (PAY-03) | XRPL submission interlock | is this submission's sequence window closed? — bookkeeping | funds settlement |
| `settled` | **PAY-05** | did the funds reach finality, and what proves it? — **funds settlement** | an authorization, a grant, a P7 release |

PAY-05 reads P11 and P12 (never writes them), never reads or writes P7, and
never reads the interlock's `settle` state. Where earlier documents say "P7
settled", read **capacity settlement**; where PAY-05 says "settled", it means
**funds settlement**.

## 2. Definition (normative)

A payment is `settled` only when:

1. its canonical execution basis says the execution **completed** — P11
   `confirmed-completed`, or P11 `unconfirmed` / no observation **and** P12
   `confirmed-completed` bound to that exact attempt and observation (§4);
2. a trusted, read-only **finality authority** for its rail, asked by an
   explicit verification, answers `final` with bounded evidence;
3. that evidence matches the canonical payment **exactly** — execution, the
   provider handle P11 / P12 recorded, amount, asset, source, destination (§6);
4. the settlement is durably recorded, once (§8).

"Settled" never means: the adapter returned success; P11 said completed; P12
said the effect completed; a merchant acknowledged; a challenge disappeared;
capacity stayed consumed; time elapsed.

## 3. The state machine (closed)

```
                      P12 resolves completed                     PAY-05 verifies finality
execution-uncertain ─────────────────────────▶ awaiting-finality ─────────────────────────▶ settled   (terminal)
       │                                              ▲
       │ P12 resolves not completed                   │ P11 confirmed-completed
       ▼                                              │
not-settleable (terminal)  ◀── P11 confirmed-not-completed / withheld
```

| state | derived from | stored by PAY-05 |
| --- | --- | --- |
| `execution-uncertain` | P11 `unconfirmed` or no observation, no P12 resolution | no |
| `awaiting-finality` | the basis completed (§4), no settlement record | no |
| `settled` | a verified settlement record whose basis still verifies | **yes — the only stored state** |
| `not-settleable` | P11 `confirmed-not-completed` / `withheld`, or P12 `confirmed-not-completed` | no |

Only `awaiting-finality → settled` is PAY-05's own transition. Every other
state is derived on read from P11 and P12 — never copied, so no second truth
can diverge (`isLegalPaymentSettlementTransition`). Illegal transitions fail
closed; `settled` and `not-settleable` are terminal. Conservatism:

- an authority that is unavailable, throws, times out or answers `not-final`
  changes nothing — the payment stays `awaiting-finality`;
- unknown is not failed, timeout is not evidence, time passing is never
  finality, a network error is never "not settled";
- there is no stored negative: PAY-05 never records "will not settle". When
  the rail **contradicts** a completed execution (for example a validated
  failure), the verification answers `finality-contradicted` and records
  nothing — P11 / P12 are immutable, and contradicting trusted facts are an
  operator's question;
- a refund never un-settles the original (§11).

## 4. Settlement basis

`readPaymentSettlementBasis` (`basis.ts`), from verified durable state only:

| P11 | P12 | basis |
| --- | --- | --- |
| no attempt (or another organization's) | — | `not-found` |
| attempt of a non-payment action | — | `not-a-payment` |
| `confirmed-completed` | — | **eligible** — `provider-confirmed-completed` |
| `confirmed-not-completed` / `withheld` | — | `not-settleable` |
| `unconfirmed` / no observation | none | `execution-uncertain` |
| `unconfirmed` / no observation | `confirmed-completed`, bound to this attempt digest, observation digest and binding | **eligible** — `resolution-confirmed-completed` |
| `unconfirmed` / no observation | `confirmed-not-completed` | `not-settleable` |
| anything unreadable, corrupt, or a resolution / handle that disagrees | — | `basis-unavailable` (never repaired, authority never asked) |

The payment's **terms** come from the committed decision the grant was issued
for — the Governance Store's verified record, organization-scoped — and are
held equal to the P11 attempt on every axis both state: request, decision and
evaluation ids, action, amount and asset, and (v2 attempts) the exact
`paymentPurpose` / `paymentReference` / `paymentRail` parameters. The source is
the governed resource; the destination is PAY-01's decoding of the governed
counterparty. P11 does not restate source and destination, and PAY-05 does not
invent a second record of them.

Never a basis: a transaction hash or provider handle alone, a protocol
challenge, a caller's assertion, a business operation, a P7 reservation.

## 5. The rail-neutral finality port

```ts
interface PaymentFinalityAuthority {
  readonly authorityId: string;
  verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer>;
}
// query: organization, execution / request / decision ids, basis kind, railId?, providerRef?,
//        payment { source, destination, amount, purpose, reference?, rail? } — all canonical, frozen
// answer: { outcome: 'final', evidence } | { outcome: 'not-final' } | { outcome: 'contradicted', reason }
```

Trusted host composition, selected per payment by a trusted synchronous
selector (`selectAuthority`, the P12 pattern: no default, no first-wins). It
**reads** the rail; it never submits, signs, resubmits, builds a payment,
retries, issues authority, creates a grant, alters P11 / P12 or touches P7.
Its answer is external integration output: read once, by descriptor, closed
(`normalizePaymentFinalityAnswer`) — a Proxy trap is never consulted, an
accessor never run, an extra key, a non-canonical amount or an oversized or
secret-named fact makes it "not an answer" (`authority-unavailable /
invalid-answer`), never "final".

**Trust boundary (stated, not hidden).** A finality authority is trusted to
interpret one rail's finality. A compromised authority can falsely declare a
payment settled — and so let a payment obligation verify, or let a refund be
requested against it (still governed by the refund requester's own authority).
It is narrowed by: the read-only port and composition; exact correlation with
the canonical basis; trusted configuration of which authority serves which
rail; bounded, normalized evidence; and having no signing, submission,
authority or grant capability. It is not trustless.

## 6. Finality evidence

```
PaymentFinalityEvidence {
  executionId                 the execution it verified
  method                      '<rail>.<method>.v<n>'  (how finality was established, versioned)
  providerRef                 the rail's handle on the final transfer — must equal P11 / P12's when recorded
  amount, source, destination what it verified — compared EXACTLY with the canonical payment
  finalizedAt?                an instant the rail itself established (UTC text), never a local clock
  facts[]                     ≤ 16 normalized { name: '<rail>.<fact>', value } — sorted, unique
}
```

Bounds: method ≤ 64, fact name ≤ 64 (dotted lowercase), fact value ≤ 256
printable non-whitespace characters, instant ≤ 40. Refused, never repaired:
credentials, bearer / basic credentials, cookies, JWTs, PEM blocks, URLs (the
execution runtime's recordable-reference rule), recovery phrases (whitespace),
secret-named facts — checked with separators folded, so `private-key`,
`private.key` and `private_key` are one name — and any raw provider body
(there is no field for one). Recorded with the authority id and
`proofDigest` = SHA-256 over `{ method, providerRef, finalizedAt, facts }`
under its own domain tag: anyone holding the rail can re-derive it.

Exact matching (`paymentFinalityMismatch`): another execution, another
handle, another amount, another asset (even the same number), another source,
another destination or destination kind — each refused as
`evidence-mismatch`, nothing written. No fuzzy matching, no tolerance, no
"same amount, so the same payment".

## 7. Explicit verification, local reads

`createPaymentSettlementService` (`service.ts`):

```
verifySettlement(executionId)
  → a settlement on record?  verified, and its basis re-checked against current P11 / P12  → settled (authority NOT asked)
  → canonical basis          not eligible / unreadable → that answer (authority NOT asked)
  → trusted selection        none → authority-unavailable / unselected
  → ask ONCE, outside every transaction, normalize closed
  → not-final / failed / invalid / contradicted → nothing written
  → final → exact match → record (BEGIN IMMEDIATE) → receipt derived from the record
readSettlement / receipt     local verified reads; never contact anything
```

No background worker, timer or poll: a settlement is established only by an
explicit, trusted in-process call. Concurrent calls for one execution in one
process share one in-flight verification; across processes the store decides
(§9). An established settlement is never overwritten by a later "not final".

Defence in depth: a settlement row is believed only while the P11 / P12
records it names are still the ones on record and its terms still equal the
committed ones (`settlement-inconsistent` otherwise) — a row written by
anything but this service, or a settlement file restored beside another
spine, yields no `settled`, no receipt, no discharge and no refund.

## 8. Settlement identity and the durable store

- **Identity:** `settlementId = payment-settlement:` + SHA-256 over
  `(organizationId, executionId)` — derived, never caller-chosen. One execution
  has at most one settlement.
- **Record:** the basis (by digest), the canonical terms, the finality evidence
  and `proofDigest`, `verifiedAt` (service clock), `recordedAt` (store clock),
  `contentDigest` (everything but the two local instants) and
  `settlementDigest`.
- **`createSqlitePaymentSettlementStore`** — one append-only table keyed by
  `execution_id` and the unique `settlement_id`; canonical JSON plus key
  columns that must restate it; triggers refuse `UPDATE` / `DELETE`; schema
  version guarded before any `CREATE` (another schema is refused unmutated);
  verify-first on every read; tenant-confined; `WAL` + `synchronous = FULL`;
  every write decision one `BEGIN IMMEDIATE`. No secret column exists.
  `createInMemoryPaymentSettlementStore` is for tests.

## 9. Idempotency, concurrency, conflicts

| situation | result |
| --- | --- |
| the same final proof again | `settled`, `established: 'previously'`, same record and receipt; the authority is not asked again |
| two workers verify one execution (two connections, one file) | one row, one settlement digest, one receipt (S16) |
| two trusted reads claim **different** final evidence | the first recorded stands; the other is `conflict` — never latest, first-by-time, highest ledger or newest instant (S15) |
| a later "not final" after `settled` | `settled` (the record answers first; nothing is downgraded) |

## 10. Receipts

A **receipt** is evidence that one canonical settlement exists — not an
authorization, grant, invoice, merchant challenge, execution or protocol
credential, new payment or P11 outcome. `derivePaymentReceipt(settlement)` is
pure and deterministic, and is the only way one is made: from a verified
settlement record, never from `PaymentRailResult.completed`.

- **Identity:** `receiptId = payment-receipt:` + SHA-256 over
  `(organizationId, settlementId)`.
- **Content:** format `frontera.payment-receipt.v1`, status `settled`, the
  settlement id and **content** digest, the execution / request / decision
  ids, rail, canonical terms, and the finality authority, method, handle,
  `finalizedAt` and `proofDigest` — and **no local instant**, so a receipt
  re-derived after a restart, a restore or a re-verification is byte-identical.
- **No store of its own.** Because it is a pure derivation, there is no crash
  window between a settlement and its receipt (C3), and no receipt can be
  emitted twice with different content.
- **Integrity and correlation, not authenticity.** `verifyPaymentReceipt`
  recomputes `receiptDigest` and the derived identities and — given the
  settlement record — re-derives the receipt and compares. An altered amount,
  asset, execution id, handle, destination or evidence digest fails. It is not
  signed: Frontera's signing keys are authority-artifact keys (CORE-01/02) and
  are not reused for payment evidence; a receipt does not prove who issued it.
- **Disclosure** (`disclosePaymentReceipt`), following PAYMENT_ARCHITECTURE §6:

| field | auditor | partner | customer | public |
| --- | --- | --- | --- | --- |
| receipt id, status | ✓ | ✓ | ✓ | ✓ |
| execution id, `finalizedAt` | ✓ | ✓ | ✓ | — |
| provider handle, method, proof digest, receipt digest | ✓ | ✓ | — | — |
| amount, asset, purpose, reference, rail, source account, request / decision / settlement ids, authority | ✓ | — | — | — |
| destination, finality facts | — | — | — | — |

The full receipt is a trusted in-process read; **no HTTP route** serves it.

## 11. Refunds

A refund is a **new governed payment**, explicitly linked to a settled original:

```
requestRefund(identity, { originalExecutionId, refundKey, amount })
  → the original's canonical settlement (read and believed, §7) — never a caller-supplied reference
  → money rules: same asset, strictly positive, exact P9                       (payment-refund.ts)
  → trusted counterparty mapping: refund source account + beneficiary          (no address-reversal assumption)
  → refund accounting: RESERVE against the original's refundable balance       (CORE-07-anchored, atomic)
  → PaymentIntent { purpose: 'refund', idempotencyKey = reference = refund-<operation> }
  → the EXISTING governed path, as the requester: Kernel, policy, P10, approval, grant, P7, claim, rail, P11
reconcileRefund(refundOperationId)  → release ONLY on proof the refund moved nothing
```

- **Not a reversal.** The original's settlement, receipt, P11 record and P7
  capacity are never touched; `100 settled` stays `100 settled` after any
  refunds (F11). The refund has its own intent, authority, grant, P7 capacity,
  P11 / P12, settlement and receipt (F10).
- **Not authority.** A settled original authorizes nothing: a requester
  without authority is denied by the Kernel like any payment (F3). No
  settlement record can mint a grant.
- **Not a retry.** The refund's governed key derives from the refund operation
  — `(organization, principal, original settlement, refundKey)` — never from
  the original's key or a PAY-04 `businessOperationId`; one refund operation is
  governed under exactly one request identity, ever. Another principal under
  the same key is a different operation and a different reservation.
- **Money rules.** Same asset only (no FX); strictly positive canonical P9
  decimals; exact `BigInt` arithmetic (`addCanonicalDecimals`,
  `compareCanonicalDecimals`, and the new `subtractCanonicalDecimals`); never a
  number, never rounded. **Partial refunds are supported**: cumulative refunds
  never exceed the original settled amount (30 + 70 of 100 succeed, a further
  0.01 is refused — F6). A refund of a refund is not offered.
- **Counted until proven.** A reservation is counted from the moment it is
  durable. It is released only by `reconcileRefund` on a definitive canonical
  fact: the refund's committed decision is `denied`; P11 `confirmed-not-completed`
  or `withheld`; or P12 `confirmed-not-completed` (F9). Unconfirmed,
  unresolved, pending approval, never decided (a crash before governance) — the
  reservation stays counted (F8). A released operation is closed; a new refund
  needs a new refund key. No automatic retry of anything.
- **Concurrency.** The reservation decision is one `BEGIN IMMEDIATE` per
  original inside one CORE-07 transition; two connections racing over one file
  and one witness reserve at most the allowable total (F7).

### Refund accounting and CORE-07

`createSqlitePaymentRefundLedger(path, { now, freshness: { boundary } })` — an
append-only, hash-chained log of `reserve` and `release` entries (unique per
operation and kind; triggers refuse `UPDATE` / `DELETE`), **always** anchored
at the CORE-07 external witness in its own slot, `payment-refund-state`:
genesis enrolled at the witness before it is written; every reservation and
release a witness transition (probe → decide → `prepare` → `BEGIN IMMEDIATE`
re-decide and insert → `finalize`), acknowledged only when durable and
witnessed; at open the history is reconciled with the witness — older (a
rollback or stale restore), lost (an empty file under a slot held beyond
genesis), forked or pending history refuses the open (F12). There is no
unanchored durable mode and no enrollment path (no earlier file ever existed).
`createInMemoryPaymentRefundLedger` is test-only, and the refund service
refuses it unless told `allowVolatileLedger: true`.

## 12. Rollback safety and the CORE-07 decision

Each PAY-05 state was analysed separately for whether a rollback could change
money-moving eligibility:

| state | rollback / loss makes … | money-moving? | decision |
| --- | --- | --- | --- |
| settlement records | a settled payment read `awaiting-finality`; receipts, discharges and refunds refused until an explicit re-verification re-derives the **identical** content and receipt from the immutable validated ledger | **no** — availability only; nothing becomes payable, refundable or verified that was not | not anchored (reconstructible from external finality); S18 |
| receipts | — (no store; pure derivation, no local instant) | no | — |
| refund accounting | a refund already sent, or still uncertain, would stop counting — **refundable balance recreated** | **yes** | anchored at CORE-07 (`payment-refund-state`); F12 |
| payment-obligation discharges | — owned by CORE-04's authenticated store, already CORE-07-anchored (`obligation-discharge-state`) | — | unchanged; PAY-05 adds nothing |

A coordinated rollback of the settlement store with the Governance Store, P11
and P12 can at most make PAY-05 believe less. A coordinated rollback of the
refund accounting with anything is refused at open while the witness lives
outside that restore domain; the witness and the refund accounting restored as
**one** snapshot is CORE-07's deployment prohibition, as for every slot.

## 13. Crash and restart safety

| boundary | durable state | on re-entry |
| --- | --- | --- |
| C1/S1 before or during the finality read | none | a later explicit verification asks once more (a read) |
| C2/S2 after the read, before the settlement commit | none | the same: the ledger fact is immutable |
| S3 after the settlement commit, before the "receipt" | settlement | the receipt is derived — no window exists |
| C4/S4 after settlement + receipt, before the discharge | settlement | the bridge records the discharge once |
| C5/S5 after the discharge, before the response | settlement + discharge | `already-recorded` (by receipt reference); no second row |
| C6 refund reservation before governance | reservation | counted; the same refund key governs the same request once |
| C7 refund execution unconfirmed | reservation + P11 unconfirmed | counted; replay never resends; P12 decides |
| C8/S6 restart at any boundary | as above | same settlement, same receipt; refund accounting reconciled with the witness at open |

No re-entry executes, submits or retries the original payment; the refund
reaches the rail only through the governed path, once per refund operation.

## 14. CORE-04 payment obligations

CORE-04 owns the lifecycle (`required`, `pending`, `discharged`, `verified`,
`waived`, `expired`) and the classification of sources. PAY-05 adds **no**
second lifecycle and puts **no** `PaymentIntent` into CORE state. It supplies
one observation through CORE-04's own trusted recorder:

```
createPaymentObligationDischarger({ settlements, registry, recorder, discharges, sourceId, writer, now })
dischargeObligation({ organizationId, obligation: { correlation, obligationType }, executionId })
  → registry (trusted, payment-specific): is this a payment obligation, and what payment does it expect?
       { amount, destination, source? }                        unknown → not-a-payment-obligation
  → the execution's settlement, believed (§7), local           none → not-settled
  → EXACT match: asset, amount, destination, source (when expected), not a refund,
                 and reference === paymentObligationReference(correlation, obligationType)
  → already reported (same source, same receipt)?              → already-recorded
  → recorder.record(writer, { correlation, obligationType, sourceId, outcome: 'discharged',
                              observedAt: now, reference: receiptId, subjectId: authorityId })
```

- **Exact correlation.** The business reference that satisfies an obligation
  is **derived** from the obligation instance (`payobl-<sha256>` over the
  correlation and kind) — not configurable, not chosen. The payer pays under
  that reference, which the governed path binds exactly into the grant and P11.
  So payment X satisfies obligation Y only if it was made **for** Y: never
  because amount and asset match, never by time window. One receipt therefore
  discharges at most one obligation; again for the same one it is idempotent;
  for any other it is a mismatch. A receipt is not a bearer authorization.
- **Independence.** Whether the report verifies is CORE-04's decision: the
  deployment configures the bridge's `sourceId` as an `independent` source
  (kind `provider_adapter` or `signed_attestation`). A caller's self-report —
  or the bridge misconfigured as a `self_reported` source — reaches
  `discharged` and stops (O11). PAY-05 never names a state or a class.
- **Observation instant.** The bridge reports at its own clock, not the
  settlement's fixed instant: CORE-04 orders reports per obligation strictly by
  observation time, and a fixed earlier instant would let any later report (a
  payer's self-report) block the independent one forever.
- **Exit proof** (`pay05-exit-proof-host.test.ts`, the shipped Host): a
  blocking `payment.settled` obligation withholds a release; the exact RLUSD
  payment completes (still withheld), a self-report reaches `discharged`
  (still withheld), finality is verified from the validated ledger, the bridge
  records the independent discharge, and the **same** release request resumes
  the **same** committed decision (decision and evaluation ids unchanged — the
  Kernel decision is not recomputed) into a grant and one execution. One XRPL
  submission in total.

## 15. XRPL reference implementation

`createXrplFinalityAuthority({ configuration, ledger, interlock })` —
`frontera.xrpl-rlusd-finality`, method `xrpl.validated-ledger.v1`.

- **Read-only.** Its ledger capability (`readOnlyXrplFinalityLedger`) is a
  frozen object with `connect`, `serverInfo`, `validatedLedgerIndex`,
  `lookupTransaction` and `ledgerHeader` — no `submit`, `autofill` or signer.
  It reads the interlock (`read` only) to locate the one transaction signed for
  the execution and its ledger window; it never writes the interlock.
- **Finality semantics.** A transaction in a **validated** XRPL ledger is
  final: validated ledgers are consensus output, immutable, never reorganized.
- **The proof** (`readXrplPaymentFinality`, pure) — reusing P12's `readLookup`
  unchanged for the execution half (hash, validated, `tesSUCCESS`,
  `delivered_amount` exact in currency, issuer and value) and adding, from the
  ledger's own transaction (API v2 `tx_json` / v1 top level): `TransactionType`
  `Payment`; `Account` = the trusted source mapping; `Destination` and
  `DestinationTag` = the governed destination (a tag present exactly when
  governed); `Amount` / `DeliverMax` exactly the governed amount, currency and
  issuer; no flags (no partial payment); the validated ledger index (and hash).
  The server must report the configured `network_id`. The hash only locates.
- **Answers.** All of it → `final`, with facts `xrpl.network-id`,
  `xrpl.ledger-index`, `xrpl.ledger-hash`, `xrpl.transaction-result`,
  `xrpl.source-address`, `xrpl.destination-address`, `xrpl.destination-tag`,
  `xrpl.currency`, `xrpl.issuer`, `xrpl.delivered-value`, and `finalizedAt` =
  the validated ledger's consensus close time. A validated failure, a delivered
  or instructed difference, any field difference → `contradicted`. Pending, not
  found, incomplete history, network failure or mismatch, an unreadable answer,
  no interlock record, a record that disagrees → `not-final`.
- **No P12 duplication, no dependency either way.** P12's authority and reader
  are unchanged; PAY-05's reader calls P12's `readLookup` and adds the
  settlement-only checks; P12 imports nothing from PAY-05.

## 16. Direct, protocol-originated and future rails

- **Direct PAY-01 and MPP → PAY-04 payments settle identically.** Settlement
  reads P11 / P12 and the committed decision; nothing in it names a protocol,
  a challenge or a business operation.
- **Rail neutrality.** The contract and the edge name no rail word (`xrpl`,
  `ledger_index`, transaction hash as a universal shape, `bolt11`, `lightning`,
  `preimage`, bank, Stripe) — enforced by `payment-runtime-boundaries.test.ts`
  and `pay05-settlement-structure.test.ts`. Rail specifics live behind the
  authority, as normalized facts under the rail's own prefix.
- **Lightning (design test only — no code).** A PAY-06 authority would answer
  `final` when the node reports the HTLC settled with the payment's preimage:
  `method: 'lightning.preimage.v1'`, `providerRef` = the payment hash, facts
  such as `lightning.payment-hash`, `lightning.preimage-sha256` (the preimage
  is a bearer secret until settled; recording its digest suffices — its
  `sha256` equals the payment hash) and `lightning.settled-at`, `finalizedAt` =
  the settlement time the node reports. No generic contract changes.

## 17. Composition, backup and health

**Embedder-composed only** (like PAY-04): no Host configuration names PAY-05,
no Host module, no route, no package export. The Master Plan's exit criterion
is semantic, and the shipped Host's PAY-03 rail and P12 are unchanged; the exit
proof composes PAY-05 beside the shipped Host exactly as an embedder would.

- **Backup ownership.** `payment-settlements` and `payment-refund-accounting`
  are listed in `EXCLUDED_DURABLE_STATE` (`scripts/portability/store-registry.mjs`):
  `backup:v1` does not cover them; the embedder backs both files up with the
  Governance Store and P11 they belong to, and keeps the CORE-07 witness
  outside that backup domain. A lost settlement file is re-verified from the
  rail; a lost or stale refund file is refused by the witness.
- **Health / readiness.** The stores answer `health()` — readable, writable,
  schema; the refund accounting adds its CORE-07 `freshness` status — with no
  evidence, address, transaction blob or secret. An embedder that treats PAY-05
  as required reports them through its own health model.

## 18. Effect paths

PAY-05 adds **no** effect path (NO_BYPASS: nine of seventy, unchanged). The
XRPL finality authority is a read-only status query of the EP-054 kind over the
existing SDK client (EP-069's file — reads only). The settlement store and
refund accounting are local records, never authority. The refund service is
one more trusted in-process caller of `GovernedActionOrchestrator.govern()`
(EP-049's orchestration entry, like PAY-04's ingress) and reaches a rail only
through it. The obligation bridge writes through CORE-04's existing in-process
trusted recorder. The refund accounting's witness transitions are an existing
EP-057 trigger.

## 19. Qualification

| suite | covers |
| --- | --- |
| `payment-settlement.test.ts` | state machine, closed answer, bounds and secret refusal, exact matching, refund money rules |
| `xrpl-finality.test.ts` | the XRPL proof: v1 / v2 shapes, every field substitution, contradictions, never-negative |
| `pay05-settlement.test.ts` | S1 – S20, R1 – R10 |
| `pay05-xrpl-settlement.test.ts` | governed RLUSD payment → PAY-02 rail + interlock → P11 / P12 → XRPL finality → settlement → receipt |
| `pay05-refunds.test.ts` | F1 – F12, C6 – C8, durable races and stale restore at the witness |
| `pay05-payment-obligations.test.ts` | O1 – O12, C4, C5 |
| `pay05-exit-proof-host.test.ts` | the obligation exit proof on the shipped Host |
| `pay05-settlement-structure.test.ts` | structural boundaries (§16, §18) |
| `pay03-xrpl-testnet-production.test.ts` | opt-in live Testnet: the PAY-03 governed payment, then settled (§20) |

## 20. Live Testnet qualification

`FRONTERA_XRPL_TESTNET_PAY03=1` runs PAY-03's production-shaped Testnet
qualification and then settles **that same** governed payment — no further
payment is made — with an embedder composition over the running Host's stores
and a fresh SDK client re-reading the validated transaction. Testnet only
(`network_id` 1 required).

Run of 2026-10-12 (XRPL Testnet, `wss://s.altnet.rippletest.net:51233`): the
governed payment `CBB93F0F5DBC2A7950DF1568DA04FDAC55A560A102416343D07C1B1A8AC149F3`
validated `tesSUCCESS` in ledger 21473742 (P11 `confirmed-completed`; the Host
never held the key); PAY-05 read it as `awaiting-finality`, then verified it —
settlement `payment-settlement:1d2b5b9aa7901d2e4606f8674e0c920c8d11ae2c581b9f6c92460cf701d65885`,
receipt `payment-receipt:18a100a66879117720a05da2f9f737c6e8a0892f30759edcc90f9416bbd63c8b`
(verified against the settlement), method `xrpl.validated-ledger.v1`,
`finalizedAt` 2026-10-12T07:15:30Z (the ledger's consensus close time), facts
`xrpl.network-id` 1 and `xrpl.ledger-index` 21473742; no further submission.

## 21. Residuals

- **Finality authority trust** (§5): a compromised authority can declare false
  finality. Mitigated, not eliminated.
- **Integrity, not authenticity**: settlement records and receipts use unkeyed
  SHA-256, as P11 and P12 do. A database writer able to rewrite a settlement
  row and its digests consistently is not detected inside the file — but a
  forged row is believed only if P11, P12 and the Governance Store say the
  same (§7).
- **Settlement store rollback costs availability** (§12): settled payments
  read `awaiting-finality` until re-verified.
- **Refund availability**: an un-decided refund (a crash before governance, a
  refusal before the Kernel, an approval pending) stays counted; there is no
  administrative release. The witness must be reachable for any reservation.
- **Contradictions are reported, not resolved**: `finality-contradicted` writes
  nothing; resolving a contradiction between a rail and P11 / P12 is an
  operator task.
- **Embedder-only**: the shipped Host composes no PAY-05 component and does not
  back up its stores (§17).
- **Mainnet**: not qualified.
