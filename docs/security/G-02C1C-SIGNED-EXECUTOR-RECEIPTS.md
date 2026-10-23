# G-02C1C — Signed Executor Receipts and Independent Verification: Security Statement

**Design:** `docs/architecture/ADR-SIGNED-EXECUTOR-RECEIPTS.md`
**Invariants:** SEC-INV-397 … SEC-INV-405 (`SECURITY_INVARIANTS.md` §4.43)
**Profile:** reference only, synthetic CI qualification. **Not production-ready.**

## 1. What a valid receipt proves, and what it does not

**A valid signature under a pinned executor key proves** that the holder of that key signed exactly this canonical record. In other words, this executor *states* that:

- it consumed this capability;
- for this binding;
- in this consumption state;
- and observed this outcome.

**It does not prove** any of the following:

- that the statement is true;
- that a provider or business transaction completed;
- that a settlement occurred;
- that the capability was issued by a given Host (`issuedHere` is G-02C1D);
- that no newer receipt exists (only the history a verifier holds can say so);
- that the effect happened exactly once anywhere.

**Why the executor key is not an authority key.** The receipt is the executor's statement about its own observation. An authority key would make it Frontera's statement, and would let a compromised executor speak as the authority. The configuration and the signer refuse an executor key whose id or material equals any pinned issuer key.

**Why no receipt can cause re-execution.** No receipt module calls the effect, claims or records a consumption outcome (pinned). Recovery reads durable state and signs.

## 2. Receipt field origins

| Field | Source of truth | Trust owner | Durable | After a crash | Bound by signature |
|---|---|---|---|---|---|
| `executorId` | executor configuration; receipt-ledger meta | executor operator | yes (meta) | yes | yes |
| `executorKeyId` | executor configuration; each receipt row | executor operator | yes | yes | yes |
| `issuer`, `capabilityId`, `executionId`, `organizationId`, `trustDomain` | G-02A consumption row (from the verified capability) | G-02A ledger | stored | yes (`readDetail`) | yes |
| `audience` | G-02A ledger meta | G-02A ledger | stored | yes | yes |
| `actionBinding.digest` | G-02A row: the signed capability's digest, equal to the executor's rebuilt digest because a claim follows only a verified match | G-02A ledger | stored | yes | yes |
| `actionBinding.format` | **derived**: the one format the executor verifies before every claim | executor configuration | no | yes (fixed) | yes |
| `consumption.claimedAt`, `consumption.ledgerState` | G-02A row | G-02A ledger | stored | yes | yes |
| `outcome` | G-02A state, refined only by the execution path's own observation of a `failed` row (**runtime-only**) | executor | the state, yes; the refinement only once in the receipt | conservative without the refinement | yes |
| `observedAt` | G-02A `outcome_recorded_at`, else `claimed_at` | G-02A ledger | stored | yes | yes |
| `observation` | the synthetic record file: name **derived**, digest of the stored bytes | executor output directory | yes (file) | yes, if the file is intact | yes |
| `sequence`, `supersedes`, `receiptId` | the receipt ledger's reservation | receipt ledger | yes | yes | yes |

No mandatory field is unavailable. The read API gap left by G-02C1B is closed by `readDetail` and `listUnresolved`.

## 3. Outcome mapping

| G-02A state | Execution-path observation | Receipt outcome | Mapping |
|---|---|---|---|
| `completed` | (any) | `completed-observed` + record digest | **exact**: refused without the matching record (`EVIDENCE_UNAVAILABLE`) |
| `failed` | `failed-observed` / `consumed-not-attempted` | the same | **exact** (basis `execution-path`) |
| `failed` | none (recovery) | `attempted-outcome-unknown` | **conservative**: the ledger does not record why |
| `outcome-unknown` | (any) | `attempted-outcome-unknown` | **exact** |
| `claimed` | (any) | `attempted-outcome-unknown` | **conservative**: an attempt may not have begun |
| absent | — | no receipt (`NOT_CONSUMED`) | **unavailable**: no pre-consumption receipts |

A terminal state is never stated as an external business effect. `completed-observed` means the executor observed its own local synthetic record.

## 4. Trust-registry rules (verifier)

- **Closed and caller-pinned:** `{ executorId, keys, audiences, organizationIds, trustDomains }`.
- **Refused at construction:** an empty registry, a duplicate executor, a key id pinned for two executors, the same key material pinned twice, a wildcard identity, and every CORE-02 rule (public SPKI only, matching type).
- **A key counts only for its own executor.** It must be pinned for the executor the receipt names, and the envelope's key id must equal the receipt's `executorKeyId`.
- **Rotation is overlap.** Old and new keys verify while both are pinned. **Removing a key makes receipts signed with it unverifiable under that registry**: a deployment that must keep verifying old receipts must keep their key pinned, or archive their verification. Trust never expands silently, and nothing is fetched.

## 5. Receipt-ledger durability, and how replay and conflict are detected

- **Reserve, sign, issue:** the canonical text is committed before anyone signs it. Signing is deterministic, so every signer of a reserved text produces the same signature.
- **Exact duplicates:**
  - a repeated request returns the stored artifact without signing again;
  - an exact duplicate in a verifier's history counts as one receipt.
- **Conflicts:**
  - a second, different receipt at one position is refused by the ledger, and reported as `conflicting` by a verifier holding both;
  - a successor is accepted only for an `attempted-outcome-unknown` predecessor, with a definite outcome observed no earlier than it, superseding it directly. That is checked by the ledger (transaction and trigger) and by the verifier.
- **Supersession meaning:** an old receipt stays authentic; it is no longer the newest known observation. `receiptState` is relative to the history supplied.
- **Not atomic across files:** two SQLite files are never one transaction. The consumption is committed first, and the receipt is derived from it later. A receipt can be missing (it is recovered) but never ahead of the consumption.
- **Not rollback resistant:** restoring an older receipt ledger forgets receipts.
  - When the consumption state is unchanged since the lost receipt, recovery regenerates the **identical** text and signature (tested), because every field is a function of durable state.
  - When the state has moved on (an `attempted-outcome-unknown` receipt lost, and the consumption since resolved), or when an execution-path refinement was lost, the regenerated receipt at that position **differs**. Two valid receipts then exist for one position, and a verifier holding both sees `conflicting` (tested).
  - Rollback is therefore detectable by a verifier that kept the old receipt. It is not prevented.
- **Reservations are signed before they are superseded:** a reservation left unsigned by a crash is always signed first, even if the consumption has moved on; the receipt that resolves it follows (tested).
- **A tampered ledger cannot redirect the signer:** before signing or returning a stored receipt, the issuer requires every field taken from durable state to match the consumption ledger, otherwise `RECEIPT_CONFLICT`. The receipt ledger file and its directory must belong to the executor's user and be writable by no one else.
- **Key rotation:** a reservation is signed by the key it names. The executor refuses to start with reservations pending under another key, rather than strand them.

## 6. Crash-recovery matrix (CI)

| Case | Consumption | Receipt ledger | Valid signature may exist | Safe to (re)generate | Effect may have happened | Effect repeated | Recovery | Remaining uncertainty |
|---|---|---|---|---|---|---|---|---|
| C1 before construction | completed | none | no | yes | yes (completed) | **no** | **redelivery** → receipt from state (the sweep lists only unresolved rows) | none |
| C2 after construction, before signing | completed | none | no | yes | yes | no | same | none |
| C3 after reservation | completed | reserved | no | yes: re-sign the reserved text | yes | no | on redelivery, the reserved text is signed and issued | none |
| C4 during signing | completed | reserved | no (in memory only) | yes | yes | no | as C3 | none |
| C5 after signing, before persistence | completed | reserved | **yes, identical to the regenerated one** | yes | yes | no | re-sign → same bytes | none |
| C6 inside the receipt-ledger transaction | as before | nothing (uncommitted) | no | yes | as before | no | as C1 | none |
| C7 after persistence, before answer | completed | issued | yes (stored) | returned, not re-signed | yes | no | stored artifact returned | none |
| C8 completed row, no receipt | completed | none | no | yes (with record evidence) | yes | no | redelivery → receipt | none |
| C9 claimed row, no outcome | claimed | none | no | yes, conservative | maybe | no | boot sweep → `attempted-outcome-unknown` | unknown, stated |
| C10 outcome-unknown row | outcome-unknown | none | no | yes | maybe | no | sweep → `attempted-outcome-unknown` | unknown, stated |
| C11 after receipt #1, before supersession | resolved later | #1 issued, #2 reserved (or #1 still reserved) | identical if signed | yes | as stated | no | a pending reservation is signed first; then #2 | a receipt ledger restored in between yields a detectable conflict |
| C12 concurrent signers | — | one chain, no conflict (tested) | — | yes | — | no | IMMEDIATE reservation; deterministic signing; duplicates do not receipt live claims | a receipt ledger restored in between yields a detectable conflict |
| C13 receipt ledger restored | as stored | older copy | the lost ones | regenerated identically (except a lost execution-path refinement) | — | no | redelivery or sweep | a verifier may hold a now-missing receipt |
| C14 receipt ledger corrupted | — | refused at open | — | — | — | no | operator restores | — |
| C15 key unavailable | unchanged | unchanged | — | after **the same** key returns | — | no | startup refused; receipts recovered when the key returns. A rotated key is refused while reservations under the old one are pending | none |

No scenario reruns the effect.

**Qualification method:**
- C1–C5, C7 and C9 run in process, with a throwing fault hook, **and** across processes with a `SIGKILL` at the fault point.
- C6 is shown at the SQLite level.
- C8 and C11–C15 run in process and in the process suite as listed.
- **Process crashes, not power loss:** the matrix qualifies process crashes. Power-loss durability rests on `synchronous = FULL`.

## 7. Adversarial coverage

| Threat | Result | Suite |
|---|---|---|
| Each of 21 receipt fields changed under the old signature (re-signing is covered by the forged-receipt and history tests) | unacceptable | in-process |
| Non-canonical, unknown or duplicated field; wildcard; malformed instant; other algorithm; other domain; no domain; unpinned key id; truncated or malformed signature | refused, named | in-process |
| Another pinned executor's key; unpinned executor; foreign audience, organization or trust domain; expectation mismatch | separate answers | in-process |
| Rotation overlap, removed key, relabelled key id | as specified | in-process |
| Exact duplicate; rival at one position; broken chain; superseded replay | one / conflicting / conflicting / superseded | in-process |
| Delete, overwrite, duplicate position, backward supersession by raw SQL | refused by triggers and constraints | in-process |
| Tampered, foreign, missing or re-created receipt ledger | refused at open | in-process and process |
| Look-alike reservation; issuer key id or material; key readable by others; link; wrong type; missing key | refused | in-process and process |
| Completed without, or with a mismatched, synthetic record | `EVIDENCE_UNAVAILABLE` | in-process |
| A stale reservation; a substituted reserved row; a rotated key with a pending reservation; a restored receipt ledger; a ledger file others can write | signed first / `RECEIPT_CONFLICT` / `RECEIPT_KEY_MISMATCH` and startup refused / `conflicting` / refused | in-process and process |
| Removal of each control | 25 mutants detected | `g02c1c-executor-receipt-mutation.test.ts` |
| Domain uniqueness; verifier closure; one signer and caller; issuer order; no effect in reach; G-02A schema unchanged; dynamic loading; no Host surface | pinned | `g02c1c-executor-receipt-structure.test.ts` |

## 8. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02C1C-R1 | Receipt history is not rollback resistant; a restored copy forgets receipts. Regeneration is identical only while the consumption state is unchanged; otherwise two valid receipts exist for one position (detectable, not prevented) | Founder (anchoring) |
| G02C1C-R8 | A writer of the receipt ledger who matches every durable field can still choose the execution-path refinement of a `failed` row (failed-observed, consumed-not-attempted or unknown) — each a statement that no completed effect was observed | reference only |
| G02C1C-R2 | The receipt key sits in a file on the executor host; no KMS or HSM | reference only |
| G02C1C-R3 | A verifier's `current` holds only within the history it was given | G-02C1D (authoritative history delivery) |
| G02C1C-R4 | Removing a key from a registry makes its receipts unverifiable there | operational |
| G02C1C-R5 | `issuedHere` is not evaluated; a valid receipt does not show the capability was issued by a given Host | G-02C1D |
| G02C1C-R6 | Completed rows without a receipt are recovered on redelivery, not by the boot sweep (which lists only unresolved rows) | documented |
| G02C1C-R7 | A successor's observation may equal its predecessor's instant (a claim and its outcome can share a millisecond); ordering is by sequence and the forward outcome rule | documented |
| G02C1B-R*, G02C1A-R*, G02C0-R*, G02B-R* | Unchanged, including consumption- and issuance-ledger rollback, independent domains, offline revocation, custody credentials and no settlement proof | as before |
