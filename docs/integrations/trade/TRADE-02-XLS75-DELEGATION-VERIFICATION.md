# TRADE-02 — XLS-75 Delegation Verification

> **Frontera never creates, changes or revokes a delegation — it only proves
> one.** A read-only reader observes the owner's XLS-75 `Delegate` entry at a
> validated ledger; a pure verifier decides whether that observation proves
> that the delegate may submit OfferCreate for the owner, now. Anything less is
> a refusal with one reason code.

- Status: implemented — domain contract and verifier, read-only reader over a two-method port, fake-ledger tests. **No composition, no network transport, no SDK import.**
- Builds on: TRADE-01 (`b8ae3a0`), TRADE-02 preflight (`f56bd2a`, `TRADE-02-PREFLIGHT-BOUNDARY-RECONCILIATION.md`).
- Specification: TRADE-00 §4.3 (protocol facts), §10 (delegation verification design), §13 (SEC-TRADE-03/04), §18 (TRADE-02 row); TRADE-01 §13.
- Branch: `feat/trade-02-xls75-delegation-verifier`.
- Unchanged: CORE, PAY-02 rail and SDK importer list, PAY-03 signer protocol and interlocks, PAY-04 ingress, PAY-05, PAY-06, registries, NO_BYPASS inventories, configuration, `package-lock.json`, website.
- Not done, by design: signing, wallets, funding, `DelegateSet`, submission, any network call.

---

## 1. Components

| File | Role |
| --- | --- |
| `src/features/trade-runtime/domain/trade-delegation.ts` | Observation contract and closed parser; `Delegate` entry key; permission canonicalisation; verifier and evidence. Pure. |
| `src/features/trade-runtime/domain/trade-grammar.ts` | + `tradeAccountIdOf` (20-byte account id of a valid classic address). |
| `src/features/trade-runtime/rails/xrpl/xrpl-delegation-reader.ts` | `XrplDelegationLedgerPort` (two read methods) and `createXrplDelegationReader`. |
| `src/features/trade-runtime/rails/xrpl/index.ts` | Rail barrel. **Not** re-exported by the TRADE root barrel (mirrors PAY: rails are imported explicitly, by a composition edge). |

## 2. The ledger key

`tradeDelegateEntryIndex(owner, delegate)` = SHA-512Half(`0x0045` ‖ AccountID(owner) ‖ AccountID(delegate)), 64 upper-case hex digits.

- Reproduces the xrpl.org `Delegate` example exactly (`rG8uoRH9uA6AJ6NRj8P4cJG1HNfYcnMPrt` → `r9GAKojMTyexqvy8DXFWYq63Mod5k5wnkT` = `749D3DCDF9F032DDDB8AC49641BACBFDD398C4B6C231C4AB325B7755962329A2`) — a committed test vector.
- Directional (owner/delegate swapped gives another key); undefined for malformed or reserved addresses.
- Offline cross-check (scratch script, not committed): 5000 random account pairs against the installed SDK's `sha512Half` and `ripple-address-codec` — 0 mismatches.

## 3. Observation contract — `frontera.trade-delegation-observation.v1`

Closed, frozen, and re-validated in full by `parseTradeDelegationObservation` wherever it is used:

| Field | Rule |
| --- | --- |
| `network`, `networkId` | A TRADE network (Testnet 1, Devnet 2) and exactly its id. Mainnet is unrepresentable. |
| `validatedLedgerIndex`, `validatedLedgerHash` | The validated ledger the entry (or its absence) was read at: UInt32 ≥ 1; 64 upper-case hex. |
| `owner`, `delegate` | Valid, non-reserved, distinct classic addresses. |
| `entryIndex` | Must equal `tradeDelegateEntryIndex(owner, delegate)`. |
| `observedAt` | `toISOString` form; taken **before** the ledger is asked, so an observation is never younger than what it saw. |
| `state: 'granted'` + `permissions`, `previousTxnId`, `previousTxnLedgerIndex` | 1–10 canonical permissions, strictly sorted, distinct; `PreviousTxnID` 64 hex; its ledger ≤ the observed ledger. |
| `state: 'absent'` | No permission fields at all. |

Permissions are canonical names; the ledger may report a number instead (xrpl.org: "String or Number"). `8 → OfferCreate`, `9 → OfferCancel`; any other number stays visible as `value:<n>` (and is excess). `value:8` is not a canonical spelling and is refused. Getters are never run; extra, missing, symbol or inherited properties are refused.

## 4. Verification — `verifyTradeDelegation(observation, requirement)`

Requirement: `network`, `owner`, `delegate`, `at` (the instant it must hold at), `maxAgeSeconds` (1–60, refused — never clamped — above), optional `minimumValidatedLedgerIndex`, optional `expectedPreviousTxnId`.

Checked in this order; the first failure is the answer:

| # | Check | Refusal code |
| --- | --- | --- |
| 1 | Observation integrity (closed parse) | `DELEGATION_OBSERVATION_MALFORMED` |
| 2 | Requirement integrity | `DELEGATION_REQUIREMENT_INVALID` |
| 3 | Network, owner, delegate binding | `DELEGATION_NETWORK_MISMATCH` / `_OWNER_MISMATCH` / `_DELEGATE_MISMATCH` |
| 4 | Ledger not below a ledger the caller already knows | `DELEGATION_LEDGER_BELOW_MINIMUM` |
| 5 | Not observed after `at` | `DELEGATION_OBSERVATION_FROM_FUTURE` |
| 6 | Not older than `maxAgeSeconds` (inclusive) | `DELEGATION_OBSERVATION_STALE` |
| 7 | Entry present | `DELEGATION_ABSENT` |
| 8 | Entry unchanged since relied on (`PreviousTxnID`) | `DELEGATION_CHANGED` |
| 9 | `OfferCreate` granted | `DELEGATION_PERMISSION_MISSING` |
| 10 | Nothing beyond `OfferCreate`/`OfferCancel` | `DELEGATION_PERMISSION_EXCESS` |

Success returns frozen `frontera.trade-delegation-evidence.v1` evidence: network and id, owner, delegate, the permission proved, all permissions, entry key, validated ledger index and hash, `PreviousTxnID` and its ledger, `observedAt`, `verifiedAt`, `maxAgeSeconds`.

### 4.1 Freshness and revocation

- **Freshness** is bounded twice: the reader refuses a node whose latest validated ledger closed more than `maxValidatedLedgerAgeSeconds` (≤ 60) ago, and the verifier refuses an observation older than `maxAgeSeconds` (≤ 60; TRADE-00 §10 proposes ≤ 10 s for the pre-sign read).
- **Revocation** is a validated `entryNotFound` → `absent` → `DELEGATION_ABSENT`.
- **No replay past a revocation**: a caller that has seen ledger *N* passes `minimumValidatedLedgerIndex: N`; an earlier "granted" is refused.
- **Revoke-and-re-grant** between decision and signing (TRADE-00 §4.3 Q17, threat 2) changes the entry's `PreviousTxnID`; a caller pinning `expectedPreviousTxnId` from the decision-time evidence gets `DELEGATION_CHANGED`.
- **Excess permissions** are refused (TRADE-00 §13.2 threats 4 and 6: a trading delegate that may also pay or burn is outside governed trading's accepted blast radius).
- This is defence in depth: the ledger re-checks at apply time (`terNO_DELEGATE_PERMISSION`), which TRADE-04 must treat as a first-class outcome.

## 5. The reader — read-only by construction

`XrplDelegationLedgerPort` has exactly two methods:

- `serverInfo()` → the `server_info` result;
- `ledgerEntryDelegate({ delegate: { account, authorize }, ledger_index: 'validated' })` → the `ledger_entry` result, error results included.

The port rejects only when the server could not be asked. It has no method that could sign, submit or ask anything else.

`observe({owner, delegate})`:

1. refuses an unkeyable request or an untrustworthy clock **before** asking anything;
2. `server_info`: the node must state exactly the network's id, have a validated ledger, and that ledger must be at most `maxValidatedLedgerAgeSeconds` old;
3. `ledger_entry` at `validated`:
   - `entryNotFound` is **absence only** when `validated: true` with a ledger index and hash; any other error, or an unvalidated answer, is `unavailable`;
   - a found entry must be validated, of type `Delegate`, `Flags` 0, at exactly the computed key (response and node), for exactly (owner, delegate), with only known fields, well-formed directory hints, 1–10 distinct permissions in `{Permission:{PermissionValue}}` wrappers, and a `PreviousTxnLgrSeq` not after its ledger;
   - the entry's ledger must not be older than the validated ledger `server_info` reported (`LEDGER_REGRESSED`: a lagging or different node);
4. the result passes the same closed parser every consumer uses.

Every failure is `{outcome:'unavailable', failure}` with one code — never "absent", never "granted". Transport errors are caught without reading their message; nothing about the node leaks. One attempt per call, no retry, no fallback.

## 6. Architectural review items (deferred, not done)

| Item | Why deferred | Needed by |
| --- | --- | --- |
| A real port over a network transport | It is a new XRPL network path. TRADE-00 §6.2/§18 put it on the shared transport extraction (ADR-XRPL-SHARED-TRANSPORT), after PAY-06, with a NO_BYPASS effect-path row. | TRADE-04 |
| Composition edge (`src/enterprise/xrpl-trade-rail/`) | The preflight pins `TRADE_COMPOSITION_EDGES = []`; adding one is an explicit decision. | TRADE-03/04 |
| An xrpl SDK `validate()` test with `Delegate` on OfferCreate (TRADE-00 §5) | It would make a TRADE test a new SDK importer; PAY-02's exact importer list allows rail, smoke and PAY-03 tests only. Run offline instead (scratch, not committed): `xrpl@5.3.0` `validate()` **accepts** OfferCreate with `Delegate`, **refuses** `Delegate == Account` ("Account and Delegate addresses cannot be the same"), and the codec round-trips the field. | Review: add a TRADE test entry to PAY-02's list, or keep it offline |
| Delegation as a CORE-04 trusted fact (`valueFrom`) | Policy integration. | TRADE-03 |
| Pre-sign re-read wiring (≤ 10 s, pinned `PreviousTxnID`, ledger floor) | Execution boundary. | TRADE-04 |

## 7. Security tests

| Suite | What it proves |
| --- | --- |
| `trade-runtime/tests/trade-delegation.test.ts` | Documented key vector; directionality; permission canonicalisation; 25 malformed-observation cases; getters never run; full refusal matrix (one code each); age-bound edges; revocation and ledger floor; revoke-and-re-grant detection. |
| `rails/xrpl/tests/xrpl-delegation-reader.test.ts` | Fake ledger: granted, validated absence, numeric permissions, excess permissions observed then refused, end-to-end observe → verify, revocation sequence; unreachable node (both calls), one attempt, no detail leak; 11 `server_info` and 9 `ledger_entry` failure shapes; 17 wrong-entry shapes; getters never run; request and clock refused before any call; configuration refused, never defaulted. |
| `rails/xrpl/tests/xrpl-delegation-reader-boundaries.test.ts` | Rail is exactly two files; port has exactly two methods and the request type admits only `validated`; each called once, no other port member; no transaction building, signing, submission, key material, SDK import, network or retry; every awaited port call guarded into `unavailable` without inspecting the error; nothing composes the rail. |
| `trade-runtime-boundaries.test.ts` (TRADE-01) | Import allowlist extended by exactly one edge: files under `rails/xrpl/` may import `../../domain/index.js`. All other TRADE-01 fences unchanged and applied to the rail. |
| `trade-vertical-structure.test.ts` (preflight) | Same one-edge extension of the TRADE import allowlist; every other assertion unchanged and applied to the rail. |

Temporary mutation checks of the reader (backup restored byte-for-byte, scratch only):

| Mutation | Caught by |
| --- | --- |
| Port gains `submit(blob)` | two-method port; no-submission |
| `ledger_entry` at `'current'` | validated-only |
| Retry loop around `server_info` | no-retry; guarded-calls |

## 8. Validation

Run in this order, one heavy suite at a time:

| Check | Result |
| --- | --- |
| Focused: TRADE domain, reader, reader boundaries, TRADE-01, trade-vertical, TRADE-01 enterprise, PAY-04 structure | 131/131 pass |
| Mutation checks of the reader (3) | all caught; reader restored |
| `npm run typecheck` / `lint` / `build` / `check:release-coherence` | pass |
| All 51 structural / boundary suites + all TRADE suites | 1002/1002 pass, 0 skipped |
| Full root suite (`npm run test:root`) | 10364 tests: **10351 pass, 0 fail**, 9 skipped, 4 todo (load average 7–15) |
| Workspace tests (`npm run test:workspaces`) | 1103/1103 pass, 0 skipped |

The 9 skips are pre-existing opt-in tests (live Testnet and similar); the 4
todos are the pre-existing PROD-01 F1 SQLite classification item.

During the first parallel structural run, PAY-03 `C9 / I7` (cold backup
restore) failed once; it passed 13/13 twice in isolation and in the full
suite. No PAY-03 file is touched. Recorded as an intermittent under parallel
load, alongside the preflight's launcher-timeout risk (preflight §5.4).

## 9. Verdict

TRADE-02 acceptance: the reader proves or refuses, there is no submit path,
keylet vectors and fake-ledger tests pass, and no PAY-02/PAY-03 boundary was
changed. **Stopped before TRADE-03.**
