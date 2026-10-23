# ADR: Signed executor receipts and independent verification (G-02C1C)

**Status:** Accepted for G-02C1C (reference only)
**Extends:** `ADR-DURABLE-CONSUMPTION-SYNTHETIC-EXECUTION.md` (G-02C1B), `ADR-INDEPENDENT-EXECUTOR-VERIFICATION.md` (G-02C1A), `ADR-GENERIC-SIGNED-EXECUTION-CAPABILITIES.md` (G-02A)
**Security statement:** `docs/security/G-02C1C-SIGNED-EXECUTOR-RECEIPTS.md` · invariants SEC-INV-397 … SEC-INV-405
**Founder decisions:** C1C-D1 … C1C-D10. HTTP delivery (D9), Host wiring and `issuedHere` correlation (D8) are G-02C1D.

## Decision

### 1. The contract: `frontera.executor-receipt.v1`

A closed `aoc.canonical-json.v1` record. Every field is required, and `null` is explicit where allowed:

```
{ format, receiptId, executorId, executorKeyId, issuer, capabilityId, executionId,
  audience, organizationId, trustDomain,
  actionBinding: { format, digest },
  consumption: { claimedAt, ledgerState },
  outcome, basis, observedAt, sequence, supersedes,
  observation: { kind, reference, digest } | null }
```

- **`receiptId`** is the digest, under its own domain, of (executor, capability, sequence). There is one logical receipt per position, every verifier can recompute it, and it is never re-minted.
- **`outcome`** is one of `consumed-not-attempted`, `attempted-outcome-unknown`, `completed-observed`, `failed-observed`. There is no settlement or business-success outcome.
- **`basis`** is `execution-path` (the executor's own observation during the attempt) or `durable-state` (what the ledger alone supports).
- **`observation`** is present exactly for `completed-observed`: the synthetic record's name and the SHA-256 of its exact bytes.
- **`observedAt`** is the instant of the durable fact the receipt rests on: the ledger's outcome time, or the claim time while no outcome was recorded.
- **Not included:** a provider reference (there is no provider), request bodies, credentials, keys, presentations, policy, grants, nonces, diagnostics or free text.

The parser enforces self-consistency on top of shape:

- the id matches its position;
- sequence 1 supersedes nothing; later sequences supersede exactly one id;
- the outcome matches the ledger state and the basis;
- `observedAt ≥ claimedAt`.

### 2. Domain and signature

- **Signing bytes:** `frontera:executor-receipt:v1\n` followed by the canonical text. The domain is prefix-free against every other signing domain and every `frontera:` literal in the source tree (structure suite).
- **Envelope:** the CORE-02 envelope (`ed25519-v1`), verified by the CORE-02 registry. There is no second cryptographic implementation.
- **Key separation:** domain separation prevents cross-use of signatures. The envelope's `artifactVersion` names the CORE-02 envelope format, not an authority artifact.

### 3. The executor's own key, and one structured signing operation

- **Configuration:** `executorReceipts { keyId, privateKeyFile, receiptLedgerPath }`, accepted only in `synthetic-execution` mode.
- **Key file:** a regular, canonical file, owned by the executor's user and readable by no one else, holding one Ed25519 private key.
- **Not an authority key:** its key id and its public material must differ from every pinned issuer key.
- **What the signer exposes:** the key id and the public PEM. The private key never leaves `receipt-signer.ts`.
- **`signExecutorReceipt(reservation)`** signs only a reservation the receipt ledger produced. That object is branded, so a look-alike is refused. It signs only for its own executor and key, and only the receipt bytes, then verifies the signature with the public half before returning it.
- **No `sign(bytes)`.** The receipt issuer is the only caller.

### 4. Read-only consumption access (C1C-D6)

G-02A's ledger gains two read-only methods, with no schema, trigger, transition or durability change:

- `readDetail(capabilityId)` returns every persisted fact of a consumption.
- `listUnresolved({ limit ≤ 100, after })` lists `claimed` and `outcome-unknown` rows in claim-time, then capability-id, order.

The binding **format** is not persisted. It is derived: the executor verifies exactly one format before every claim.

### 5. The receipt ledger (C1C-D5)

A separate SQLite file, `frontera.executor-receipt-ledger.v1`, pinned to one executor and one audience. The executor never creates it; the operator does, explicitly, once.

- **Reserve, then issue:**
  - an IMMEDIATE transaction decides the position and commits the whole canonical text as `reserved`;
  - the signer signs that text;
  - `issued` records the signature.
- **Why that is crash-safe and race-free:** Ed25519 signing is deterministic, so a retry or a competing process reproduces the same signature byte for byte. Two different texts are never signed for one position, and a signature lost in a crash is reproduced, never replaced.
- **Positions:**
  - unique `(capability_id, sequence)` and `receipt_id`;
  - an unchanged consumption state returns the receipt already there;
  - a changed state may only supersede an `attempted-outcome-unknown` receipt, with a definite outcome observed no earlier (a trigger enforces predecessor, position and outcome);
  - every other change is a conflict.
- **Immutability:** no delete, no edit except reserved → issued, and the identity row is fixed.
- **Integrity at open:** tables, triggers, `quick_check`, schema version, executor and audience are checked, and every row is re-parsed, re-digested and matched to its columns.

### 6. Issuance from durable state

The order is fixed:

1. Read `readDetail`.
2. Map the state, refined only by the execution path's own observation of a `failed` row.
3. Require the synthetic record as evidence for `completed`.
4. Reserve.
5. Sign.
6. Issue.

The flow asks for a receipt only after the outcome is durably recorded, and on a duplicate delivery (from durable state alone). Its answer never changes the flow's.

At boot, a recovery sweep gives every unresolved consumption the conservative receipt its state supports. Nothing in the receipt path claims, records an outcome or touches the effect.

### 7. The standalone verifier (C1C-D8)

`createExecutorReceiptVerifier({ trustedExecutors })` takes a closed registry. Each entry pins an executor id, its key(s), and its permitted audiences, organizations and trust domains. A key carried in a receipt is never trusted, and nothing is fetched.

`verify` returns separate answers:

| Answer | Meaning |
|---|---|
| `canonical` | the receipt is the one canonical spelling and self-consistent |
| `executorTrust` | the executor and its key id are pinned in the registry |
| `signature` | the signature over the receipt domain and this text is valid |
| `scope` | the audience, organization and trust domain are permitted for that executor |
| `identityMatch` | the receipt names what the caller expected |
| `bindingMatch` | the receipt's action binding matches the caller's (`unknown` without one) |
| `receiptState` | `current`, `superseded` or `conflicting` within the history supplied; `unknown` without it |
| `reportedOutcome` | the outcome the executor reports |

Two fields are fixed in this milestone: `externalConfirmation` is always `not-established`, and `issuedHere` is always `not-evaluated` (that check is G-02C1D).

There is no single success boolean. `assessHistory` checks one subject per chain, one receipt per position (an exact duplicate counts once), contiguous sequences and forward-only supersession.

## Rejected alternatives

| Alternative | Why not |
|---|---|
| Receipt tables in the G-02A ledger | Migration of a closed schema |
| Signing the authority key, or reusing an authority domain | The receipt states the executor's observation, not Frontera's authority |
| Signing before reserving | Two processes could sign different texts for one position |
| `observedAt` = time of signing | Regeneration after a crash or a receipt-ledger restore would yield a different, conflicting receipt |
| A provider reference field | No provider exists; and a provider reference is never settlement proof |
| Pre-consumption refusal receipts | Not backed by durable consumption; would need its own protocol |

## Consequences

- The executor can produce, and a third party can verify, an authenticated statement of what it observed for one consumption. Recovery regenerates the same statement.
- Receipts do not prove external completion, global exactly-once, or Host issuance. They do not resolve P12 and they are not delivered over HTTP yet.
- Receipt history is as rollback-prone as its file.
