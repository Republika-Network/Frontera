# G-02C1D — End-to-End Capability Presentation and Verified Executor Receipt Evidence: Security Statement

**Scope:** reference only, synthetic. **Architecture:** `docs/architecture/ADR-END-TO-END-CAPABILITY-RECEIPT-EVIDENCE.md`. **Invariants:** SEC-INV-376 (amended), SEC-INV-406 … SEC-INV-414. **Not a production distributed-execution release.**

## 1. What this milestone does and does not establish

| Statement | Established? |
|---|---|
| The Host presents to the executor exactly the capability it issued and verified for the exact request, in one fixed header | **yes** (in-process and over real HTTP/1.1 bytes, separate processes) |
| The request binding is the same on both sides with the header present | **yes** (golden digest compared with the executor's own reconstruction) |
| A signed receipt proves **the executor's statement** of what it observed | **yes**, against operator-pinned keys only |
| A correlated receipt is about **a capability this Host issued** for **this** execution and binding | **yes**, from the Host's own issuance ledger |
| The effect happened in the world / settled | **no** — the executor's observation of a synthetic local record; `externalConfirmation` stays `not-established` |
| Global exactly-once | **no** — one consumption per executor ledger; separate ledgers are separate domains |
| Rollback resistance of any ledger or store | **no** — detectable as `conflicting` where both receipts are held, never prevented |
| Timely revocation at an offline executor | **no** — an issued capability is honoured within its lifetime (tested) |
| TLS, public DNS, address policy over a real answer, proxies | **not qualified** — loopback HTTP only (§3) |

## 2. The trust-boundary change (D1)

**Before:** the Generic HTTP gate could stop a request and never change one; the capability was discarded after verification.
**After:** on a proceed, and only then, the request carries **one** additional header, `frontera-execution-capability`, whose value is the canonical G-02C1A presentation of the issued capability text and its custody signature.

- **What crosses the boundary:** the capability (closed G-02A record; its grant reference is an opaque digest) and its signature. No grant, nonce, policy, approval, credential, key or Host evidence.
- **Who decides:** the gate alone, after issuance, verification as the executor would, execution/subject/window equality and the emergency re-read. The adapter only appends; it never chooses the name, and refuses a decorated or malformed value.
- **What cannot happen:** a presentation after a refusal; a second presentation header (the name is reserved from mapping, credentials and the provider reference, and the transport's headers are one map); any other header added, removed or replaced; a binding computed over the header.
- **Unchanged:** the G-02C0 binding format and its one credential exclusion; the executor's reconstruction already leaves out exactly this header (G-02C1A).
- **Pins narrowed, no wider:** SEC-INV-376's verdict pin now admits exactly `presentation?: string`; the G-02B "no capability in execution adapters" pin sets aside exactly the one literal `'frontera-execution-capability'` in `governed-headers.ts`; the G-02C1A "only the gate imports the presentation codec" pin admits the gate's encoder alone.

## 3. Transport assumptions

The adapter's request is copied, never mutated: the bound request is frozen and the presented one is a new frozen object. Method, origin, encoded target, mapped headers, credential identity and body bytes are those bound; redirects are never followed; there is one send and no retry; the body of the answer is never read; of its headers only the provider reference and the receipt header are read, every raw value, never joined.

**Qualified (CI):** the real `sendOnce` with the transport's exact request options writes the bytes; Node's HTTP/1.1 client and the executor's strict parser are real, in separate processes.
**Not qualified:** TLS and certificate verification, SNI, public DNS, the public-address policy over a real answer, the connect-address check (bypassed by the Unix-socket relay used in the shipped-Host suite), proxies and middleboxes. The loopback primitive marks the TLS phase as reached at TCP connect so a later loss is `unconfirmed`, as it would be after `secureConnect`.

## 4. The Host evidence store contract (D8)

| Property | Rule |
|---|---|
| Identity | `frontera.execution-receipt-evidence-store.v1`; pinned to the Host's issuer, organization and trust domain; another identity is refused at open |
| Creation | by the operator only (`create: true`); the Host refuses a missing file |
| Custody | file and directory owned by the Host's user and writable by no one else |
| Accepted evidence | a receipt from **the one executor pinned for the adapter's audience**, verified against the pinned registry and correlated with this Host's issuance — stored verbatim (text and envelope) with its digest; outcome and agreement recomputed from the stored text, never taken from the caller |
| Uniqueness | one row per receipt id, per digest, per (capability, sequence); an identical repeat is idempotent |
| Conflicts | a different text at a taken position (`POSITION_TAKEN`), a successor of a definite outcome (`SUPERSESSION_INVALID`), a successor whose predecessor was never accepted (`PREDECESSOR_UNKNOWN`) — each preserved once, never accepted, never overwriting |
| Supersession | forward only: the unknown at the position before, by a definite outcome observed no earlier — in code and by trigger |
| Observations | one append-only row per presented exchange — including a store-side refusal (`STORE_TEXT_MISMATCH`, `STORE_SCOPE_MISMATCH`), which is recorded, never dropped: transmission, status, the adapter's outcome, disposition, closed failure code, receipt digest and outcome, agreement |
| Immutability | no update or delete on any table (triggers); the identity row is fixed |
| Integrity at open | `quick_check`, version, identity; the whole schema — every table (with its constraints), index and trigger — compared **by SQL** with this version's definition, so a same-named no-op trigger is refused; every evidence and conflict row re-parsed and re-digested against its columns. Envelope signatures are **not** re-verified at open (the store holds no registry); a writer of the file who forges a whole row with a valid digest is the rollback/custody risk G02C1D-R3 |
| Durability | WAL, `synchronous = FULL`; survives restart (tested) |
| Isolation | no P11/P12 table; no P11/P12/reconciliation module reads or writes it; it resolves nothing |
| Diagnostics | closed codes and digests only; no receipt text is ever logged |

## 5. Receipt verification trust matrix

| Presented | Disposition | Failure |
|---|---|---|
| no receipt header (incl. no answer) | `receipt-missing` | `RECEIPT_MISSING` |
| two or more receipt headers | `receipt-duplicated` | `RECEIPT_DUPLICATED` |
| malformed / non-canonical / oversized / bad envelope / invalid receipt text | `receipt-invalid` | `RECEIPT_*` |
| executor not pinned | `receipt-invalid` | `EXECUTOR_UNTRUSTED` |
| another pinned executor than the one for this audience | `receipt-uncorrelated` | `IDENTITY_MISMATCH` |
| key id not pinned for that executor, or envelope key ≠ receipt key | `receipt-invalid` | `EXECUTOR_KEY_UNTRUSTED` |
| pinned key id, wrong key (forged) | `receipt-invalid` | `SIGNATURE_INVALID` |
| audience, organization or trust domain outside the executor's pinned scope | `receipt-invalid` | `SCOPE_NOT_PERMITTED` |
| no issued capability for the execution (this audience, this issuer) | `receipt-uncorrelated` | `ISSUANCE_NOT_FOUND` |
| another execution, capability or issuer (another Host) | `receipt-uncorrelated` | `IDENTITY_MISMATCH` |
| another action binding | `receipt-uncorrelated` | `BINDING_MISMATCH` |
| claim before issuance (beyond skew) or at/after expiry | `receipt-uncorrelated` | `TEMPORALLY_INCONSISTENT` |
| valid, correlated, conflicting with the stored chain | `receipt-conflicting` | conflict reason |
| valid, correlated | `receipt-correlated` | — (`agreement`: `consistent` / `contradicts` / `not-comparable`) |

A receipt replayed from another execution is `IDENTITY_MISMATCH`; the same receipt for the same execution is idempotent.

## 6. Crash, loss and uncertainty matrix (CI)

Rows marked † are qualified in process (`g02c1d-receipt-evidence.test.ts` or the G-02C0 gate suite); every other row runs the executor in its own process (`g02c1d-end-to-end-process.test.ts`, `g02c1d-shipped-host.test.ts`).

| Event | Adapter / P11 | Executor durable state | Effects | Host evidence | Recovery |
|---|---|---|---|---|---|
| † capability issued, never presented (gate withheld after issuance, e.g. an emergency stop) | `failed` | none | 0 | none | issuance ledger keeps the row |
| executor refuses (wrong audience, tampered body/target/header/method, duplicate presentation, expired) | `failed` | not consumed | 0 | `receipt-missing` | — |
| executor crash after claim | `unconfirmed` | `claimed` | 0 | `receipt-missing` | executor boot sweep receipts an unknown; Host not re-presented |
| executor crash after effect | `unconfirmed` | `claimed` | 1 | `receipt-missing` | unknown receipt on the executor; never "completed" from a claim |
| executor crash after outcome | `unconfirmed` | `completed` | 1 | `receipt-missing` | receipt issued on redelivery only; Host never redelivers |
| executor crash after receipt persisted | `unconfirmed` | `completed`, receipt issued | 1 | `receipt-missing` | receipt on the executor ledger, undelivered |
| response lost after the executor acted | `unconfirmed` | `completed`, receipt issued | 1 | `receipt-missing` | as above |
| † Host crash before evidence persisted | the observer runs detached **after** the result is handed back, so P11 is never delayed by evidence; a crash before P11 records loses P11's row exactly as before G-02C1D | as performed | 1 | none | nothing re-presented; absence of evidence is not absence of effect |
| duplicate delivery of the same capability | `unconfirmed` (202) | unchanged | 1 | replayed receipt, idempotent | — |
| † conflicting delivery | as classified | — | — | `receipt-conflicting`, both kept | — |

No failure path sends, re-presents or re-executes. A missing receipt is never read as "completed" and never as "nothing happened".

## 7. Adversarial coverage

Forged capability and receipt; wrong issuer or executor key; wrong audience, organization and trust domain (cross-domain replay); different execution and capability; modified binding digest; modified method, target, header and body; duplicate presentation and receipt headers; untrusted executor; a receipt correctly signed for another Host; missing issuance; rollback-induced conflicts and invalid supersession (store and verifier); receipt replay; a refused gate (no lookup, no send); a missing receipt (never completed); P12 untouched (structural); no secret in evidence or diagnostics; legacy, ungated adapters unchanged. 24 mutants (`g02c1d-end-to-end-mutation.test.ts`) remove each load-bearing presentation, decoding, verification, correlation, ordering and uniqueness control.

## 8. Production blockers (retained and new)

1. **TLS-terminated executor qualification** with certificate pinning or verified PKI, real DNS and the address policy.
2. **Receipt retrieval route** (authenticated, read-only) — a founder decision; until then lost receipts stay on the executor.
3. **Key custody** for executor receipt keys (KMS/HSM) and an operational key-rotation protocol for the pinned registry.
4. **Online revocation / status** at the executor (`statusPolicy` beyond offline-only).
5. **Rollback resistance** (anchoring) for the issuance ledger, consumption ledger, receipt ledger and evidence store.
6. **Cross-ledger reconciliation** of evidence with P11/P12 by an operator workflow — evidence is informational only.
7. **Real provider effects** and settlement confirmation — out of scope; synthetic only.
8. All earlier G-02 blockers stand.

## 9. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02C1D-R1 | A compromised executor key can sign false statements about capabilities it received; correlation limits them to real issuances | Founder (custody) |
| G02C1D-R2 | Evidence absent after a lost answer is indistinguishable from "never delivered"; the executor ledger holds the truth until retrieval exists | Founder (retrieval route) |
| G02C1D-R3 | Whoever can write the evidence store file can delete history (rollback); integrity checks catch edits, not truncation to an older valid state | reference only |
| G02C1D-R4 | Loopback qualification does not cover TLS, DNS, proxies or the connect-address check | Production qualification |
| G02C1D-R5 | Supersession in the evidence store is reachable only from a re-delivered receipt; with no retrieval route a successor normally arrives as `PREDECESSOR_UNKNOWN` — qualified in process, not by a real end-to-end flow | reference only |
| G02C1D-R6 | Opening the store re-reads every row: open time and memory grow with history (a boot-time cost on a large store) | Production hardening |
| G02C1D-R7 | The evidence write is synchronous SQLite on the Host's event loop (detached from the result, bounded by a 1 s busy timeout) | Production hardening |
