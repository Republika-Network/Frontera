# TRADE-04C-S1 — Grant-Bound Delegated OfferCreate Signer Authorization

- Milestone: TRADE-04C-S1. It closes TRADE-04C residual risk **R1** (§28/§33 of `TRADE-04C-GOVERNED-OFFERCREATE-EXECUTOR.md`) for credential theft.
- Branch: `feat/trade-04c-signer-grant-capabilities`, worktree `Frontera-trade-04c-s1`.
- Baseline: `main @ ffcf599742f3bd99441b289a924c95b923a220c8` (PR #190).
- Architecture: the design gate (§2) offered two options — a new CORE-02 per-order capability (Option 1) or signer-side verification of the existing signed grant only (Option 2, rejected: it could not bind the preimage, `Sequence`, `Fee`, LLS or execution). **Option 1 was approved by the user on 2026-10-15** and is what is built. It adds a new CORE-02 authority artifact and signing operation; no new root of trust is introduced.
- Status: implemented and committed locally. Not pushed, no PR. The verdict is in §16 (READY FOR PR, not production-ready).

> **What this does and does not claim.** After this milestone, a stolen bearer credential for the delegated signer obtains **zero** signatures from a signer implementing protocol v2; the reference signer is one. A capability signs at most once. Nothing here prevents a **compromised delegate key or signer process** from signing outside Frontera. Nothing here makes the stack production-ready: that still needs operational custody, recovery (TRADE-04D) and real-network qualification (TRADE-05).

## 1. Reconnaissance (summary)

| Check | Result |
|---|---|
| Ancestry | `HEAD = origin/main = ffcf599`; TRADE-04A `11db917`, TRADE-04B `d9339a5`, TRADE-04C `ffcf599` are all present |
| Reusable authority | CORE-02 Ed25519 key, software or external custody. It already signs every bounded grant. A trade grant pins `tradeProposalDigest`, `tradeNetwork` and `tradeDelegateAccount` as exact CORE-03 tokens, along with the owner resource and the organization. |
| Not provable by existing artifacts | The signing preimage, `Sequence`, `Fee`, `LastLedgerSequence` (all chosen after the grant), P11 claims (unsigned) and revocation freshness at a remote verifier |
| Grant store read | `read()` verified the signature but did not return it |
| CORE-02 protocol | Closed set of five operations. The reference custody service enforced no policy (AA-010). |

## 2. Security design gate (A–K) and decision

| | Question | Answer as built |
|---|---|---|
| A | Attack | A bearer credential alone could get any closed, in-bounds OfferCreate signed for a pinned pair. |
| B | Issuer | The **existing CORE-02 authority key**, under its existing custody. There is no Host-held key and no new root. |
| C | Proof of grant and P11 | **Grant:** the custody boundary verifies the presented signed grant under its own key and checks that the capability's terms are the grant's exact tokens (§5). **P11:** the execution id is **Host-attested** — bound into the signed capability, but not independently cryptographically proven: no signed P11 artifact exists, and adding one was not proposed. A compromised Host could name any execution id. |
| D | Custody | Unchanged. External custody gains one opt-in structured operation (§6). |
| E | Verification | The signer pins 1–8 authority public keys (key id, `ed25519-v1`, SPKI PEM), the trust domain and the organization, and verifies with CORE-02's own `createAuthorityArtifactVerifier` under the capability's domain. |
| F | Exact binding | `signingPreimageDigest` = `sha256` over `STX\0` ‖ the signing fields, with `SigningPubKey` set to the pinned delegate key. It also compares owner, delegate, network, `Sequence`, `Fee` and LLS field by field, and the order derived from the granted proposal. |
| G | Expiry, revocation, network, replay | The capability lifetime is ≤ 60 s and never past the grant; the signer judges it by its own clock with a ±5 s issuance skew. Revocation is checked at issuance by the authenticated store read; a later revocation is **not** visible to the signer. Network: pinned and bound. Replay: the durable ledger (§8). |
| H | Crash | The capability is consumed and committed before the key is touched. A crash before or after signing leaves it consumed, so it is never reusable. A crash after signing leaves the row `consumed` or `signed`; the signer never re-signs and never returns a stored blob. |
| I | Stolen credential | Zero signatures (§12). |
| J | Compromised signer or key | Outside the guarantee. It can sign anything XLS-75 permits. |
| K | Payment, G1, G2, G4 | Unchanged (§13). |

## 3. Threat model

| Adversary | Before S1 | After S1 |
|---|---|---|
| Holds the signer bearer credential and can reach the signer | Any in-bounds order, unlimited | **Nothing** without a capability (§12) |
| Credential plus a capability observed in transit **after** the Host used it | n/a | Nothing: it is consumed (409) |
| Credential plus control of the channel, intercepting a capability **before** the Host uses it | n/a | At most the exact authorized blob, once. Frontera sends nothing for that order (its request is spoiled). Tested on the shipped Host. |
| Holds a leaked signed grant | n/a | Nothing: a grant is not a capability, and the custody service issues capabilities only to its Host |
| Compromised Host | Unlimited | Unchanged (AA-010): it can ask for grants and capabilities through the authority's credential |
| Compromised signer process or delegate key | Unlimited | **Unchanged — outside this guarantee** (tested as such, §12) |
| Rewrite or rollback of the signer's ledger (deleting rows, or restoring an older copy of the file) | n/a | Consumed capabilities become reusable until they expire (≤ 60 s): a signer-host compromise, outside this guarantee. No external freshness anchor protects the ledger. |

## 4. Cryptographic authorization contract

The artifact is `frontera.xrpl-delegated-offer-capability.v1`, operation `sign-xrpl-delegated-offer`. It is a closed record with lexicographic keys and no whitespace. It is parsed **only** from its canonical text, round-trip exact. Its signing domain is `frontera:authority-artifact:xrpl-delegated-offer-capability:v1\n`.

| Field | Binds |
|---|---|
| `format`, `operation` | protocol version, and delegated OfferCreate only |
| `capabilityId` | 32 random bytes, single-use identity |
| `issuerKeyId` | the authority key id; it must equal the envelope's key id |
| `organizationId`, `trustDomain` | the organization, and the configured `governedActions.trustDomainId` |
| `grantStoreId`, `boundedGrantId`, `grantDigest` | the authenticated grant (store id, id, digest) |
| `executionId` | the P11 execution — Host-attested: bound, not independently proven |
| `proposalDigest` | the TRADE-01 proposal the grant names |
| `signingPreimageDigest` | the exact canonical signing bytes |
| `ownerAccount`, `delegateAccount`, `network` | the pair and the ledger (Testnet or Devnet only) |
| `sequence`, `fee`, `lastLedgerSequence` | the operational fields |
| `issuedAt`, `expiresAt` | the validity window |

The envelope is CORE-02's `{ algorithm: 'ed25519-v1', keyId, signature, artifactVersion }`. Changing any field invalidates the signature; this is tested field by field.

## 5. Issuer trust and custody

**Host side** (`delegated-offer-capability-issuer.ts`). The composition root binds the issuer once, into a write-once slot it receives from the trade composition, over the **authenticated durable grant store** it opened and its authority signer. The issuer:

1. reads the grant with `readSigned`, getting the verified grant, its store id and its signature;
2. refuses an absent, revoked or expired grant;
3. assembles the capability for exactly what the executor prepared, with a lifetime of at most 30 s by default and ≤ 60 s by rule, never past the grant;
4. applies the issuance rule locally;
5. asks the signer;
6. verifies the result under the active key.

The Host refuses to serve with an unbound slot, and the executor's health is then `unhealthy`.

**Custody side** (`assessDelegatedOfferCapabilityIssuance`). This rule runs inside every signer implementation, before any capability is signed. It requires:

- a well-formed grant: digest plus CORE-03 semantics;
- the grant's signature verifying under the custody boundary's **own active key**;
- the capability naming that grant, its digest and its store;
- the grant's exact `tradeProposalDigest`, `tradeNetwork` and `tradeDelegateAccount` tokens equal to the capability's;
- the grant's resources containing `<network>:<owner>`, and the grant's organization equal to the capability's;
- an issuance instant within ±5 s of the custody clock;
- a lifetime of at most 60 s that never outlives the grant.

The authority key therefore signs a capability only for a grant it signed itself. It remains an oracle for **grants** (AA-010).

## 6. CORE-02 protocol extension (opt-in, exact)

The extension operation is `signDelegatedOfferCapability` at `/v1/sign/xrpl-delegated-offer-capability`. Its request is `{ protocol, capability: <canonical>, grant: <canonical>, storeId, grantSignature }`.

- A deployment requires it only when `xrplTradeExecution` is configured. The identity must then offer **exactly** the five core operations plus this one.
- Every other deployment still requires exactly the five.
- The reference custody service offers it only when started with `FRONTERA_REFERENCE_SIGNER_EXTENSIONS=signDelegatedOfferCapability`.
- A rule refusal is HTTP 422, which maps to `EXTERNAL_SIGNER_REFUSED` and is never retried.

## 7. Delegated signer protocol v2

`frontera.xrpl-delegated-offer-signer.v2` is a closed record.

| Message | Change from v1 |
|---|---|
| Request | Gains `proposal` (an accepted TRADE-01 proposal) and `authorization: { capability, signature }`. The v1 `audit` block is **gone**. |
| Response | Gains `capabilityId`. |
| Identity | Gains `authorization: { trustDomain, organizationId, issuerKeyIds }`. |

A v1 request, a v1 identity, or a request without a capability is refused. There is no fallback.

**Signer-side order** (reference, pinned by `trade04b-protected-signer-structure.test.ts`):

1. transport authentication;
2. closed request, signer id, network, held pair;
3. **capability chain**: parse → signature under the pinned keys → pinned issuer that is also the named issuer → time → trust domain and organization → network → pair → preimage, `Sequence`, `Fee`, LLS → proposal digest → proposal-to-transaction derivation;
4. request-id replay check;
5. fee ceiling;
6. LLS horizon, when a trusted ledger reference is injected;
7. `Expiration` against the clock;
8. **durable consumption**;
9. signing;
10. self-verification;
11. `markSigned`.

**Host-side client.** Before sending anything, it checks that the capability is bound to the transaction, pair, network and proposal. It requires the response's `capabilityId` to match. The executor checks the issued capability's execution, grant and preimage before signing, and the signature's capability and execution after.

## 8. Capability lifecycle, replay and concurrency

The lifecycle is: issued (Host) → presented once → **consumed** (signer ledger, committed) → `signed` (with the transaction hash) or `signing-failed`. A row only moves forward and is never deleted; triggers enforce both.

| Mechanism | Detail |
|---|---|
| File | SQLite, WAL, `synchronous=FULL`. A file path is required (`:memory:` is refused). |
| Uniqueness | `capability_id` is the primary key; `execution_id` is unique. |
| Consumption | Takes the `IMMEDIATE` write lock before its checks, so two processes sharing the file serialize. |

Tested:

- 12 concurrent HTTP requests with one capability give one signature.
- Two signer instances on one file give one signature per capability over 10 rounds; two separate launcher processes give the same over 5 rounds.
- Replay after a restart is refused, both in process and with the separate launcher.
- A crash after consumption leaves `consumed` with no hash, and the capability is refused after restart.
- A signing failure leaves `signing-failed`, never reusable.

## 9. Key rotation and revocation limitations

| Topic | Behaviour |
|---|---|
| Rotation | The signer pins up to 8 issuer keys, so a rotation overlap is possible: add the new key at the signer, rotate the Host's active key, then remove the old one. The custody rule verifies grants under the **active** key only, so after a rotation a grant signed by the previous key can no longer be authorized. In-flight orders fail closed and need a new grant. |
| Revocation | Checked at issuance through the authenticated, CORE-07-fresh store read. A revocation committed after issuance is **not** seen by the signer. The window is bounded by the capability lifetime (≤ 60 s, default 30 s) and by the executor's single attempt. No remote revocation-freshness proof exists, and none is claimed. |
| Emergency stop | Withholds before any grant; unchanged. |

## 10. Backward compatibility

| Area | Effect |
|---|---|
| Signer protocol | v1 is **removed**. A trade Host speaks only v2, and a signer must be upgraded together with the Host. The identity handshake refuses a v1 identity as malformed (`UNAVAILABLE`), and every v1 request is refused. |
| CORE-02 | Deployments without trade execution are unchanged: exactly five operations. A trade deployment under external custody needs a custody service offering the extension. |
| `AuthorityArtifactSigner` and verifier | The signer gains the optional `signDelegatedOfferCapability`; the verifier gains `verifyDelegatedOfferCapability`. |
| Grant store | `readSigned` is read-only; no schema change. |
| Trade interlock evidence | Unchanged. No durable schema migration; the capability id is in the trace and the signer's ledger, keyed by execution id. |
| Configuration | Nothing new on the Host. The trust domain is the existing `governedActions.trustDomainId`. |

## 11. Customer-operated signer requirements

A customer signer must:

- implement v2 exactly, applying §7's chain before touching a key (reuse `authorizeDelegatedOffer`'s semantics);
- pin the deployment's authority public key(s), trust domain and organization from configuration, never from a request;
- consume each capability, and each execution id, **durably and atomically before signing**, retain consumption at least beyond every issued capability's expiry, and never re-sign or return a stored blob;
- refuse any request without a capability;
- keep its clock disciplined: expiry is judged by it, with ±5 s issuance skew;
- keep the delegate key in custody it controls (HSM or KMS at its discretion);
- grant the narrowest XLS-75 permission.

The reference launcher's environment is:

```
FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_AUTHORITY_KEY_ID / _AUTHORITY_PUBLIC_KEY_FILE
FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_TRUST_DOMAIN / _ORGANIZATION_ID
FRONTERA_REFERENCE_XRPL_OFFER_SIGNER_CONSUMPTION_LEDGER
```

## 12. Security results (§6 of the milestone)

| Requirement | Evidence | Result |
|---|---|---|
| Stolen bearer credential, no capability | `trade04c-s1-signer-authorization` (ed25519 and secp256k1), `-host` (shipped Host, signer port), separate launcher | **0 signatures** |
| Forged capability or unknown issuer | garbage signature; self-signed; signed by key B claiming key A; untrusted key | refused |
| Expired, not yet valid | ±60 s cases, and expiry exactly at now | refused |
| Replayed, concurrent, after restart | 409; 12 concurrent → 1; two instances → 1 per capability; two processes → 1; restart | single use |
| Another transaction | price, quantity, issuer, currency, flags, Expiration, Sequence, Fee, LLS | refused |
| Owner, delegate, network, scope | another pair; Devnet; trust domain; organization | refused |
| Another grant or execution | another proposal; proposal of another order; second capability for a consumed execution; executor-side identity check | refused |
| Issued before approval | withheld or denied orders on the shipped Host consume no capability; the issuer refuses an absent grant | impossible / refused |
| Revoked or expired grant | issuer: revoked → `CAPABILITY_GRANT_REVOKED`; custody rule: expired → `GRANT_EXPIRED` | refused (window §9) |
| Valid operation | unit, shipped Host, separate process | exactly one signature |
| Signature ≠ submission | `signed-not-submitted`; no submit route; ledger `signed` | holds |
| Signer unavailable | `OFFER_SIGNER_NOT_VERIFIED`; nothing consumed | fail closed |
| Compromised delegate key | a blob signed directly by the key verifies | **outside the guarantee** (asserted) |

## 13. Preservation

- **Payment:** signer protocol, rail, codec, transport and reference are unchanged; no file under `src/enterprise/xrpl-payment-rail` was touched.
- **G1** is not authorized. **G2:** the one `submit` site is unchanged. **G4:** the interlock is unchanged.
- **P11, P12, CORE-07:** unchanged. **TRADE-03:** provenance (R8) is unchanged.
- **Mainnet** is not representable in the capability, the signer or the executor.
- **Scenarios A–F:** pass on the shipped Host through the hardened signer. Scenario E is now refused by the **signer** (capability mismatch, zero signatures); a separate case keeps a compromised signer refused by the Host's verifier.

## 14. Mutation results

`trade04c-s1-mutation.test.ts` reports **30 mutants, all detected**, plus 2 controls (32/32). Each guard presents a request that only the removed check refuses.

| Module | Mutants removed |
|---|---|
| Signer authorization chain (16) | signature verification; issuer pin; named-issuer equals signer; expiry; not-yet-valid; trust domain; organization; network; pair; signing preimage; `Sequence`; `Fee`; LLS; proposal digest; proposal network; proposal-to-transaction terms |
| Reference signer and ledger (4) | signing without authorization; ignoring consumption; single-use ledger (explicit checks plus key constraints together); execution uniqueness |
| Host client (2) | sending an unbound capability; accepting an answer for another capability |
| Executor (2) | using a capability for another execution; accepting a signature under another capability |
| Custody issuance rule (6) | grant signature; proposal token; organization; owner resource; maximum lifetime; not past the grant |

Additionally, TRADE-04B's 15 and TRADE-04C's mutants still pass. TRADE-04C's `change-taker-gets-after-grant` was retargeted to the executor's binding of the shared derivation. **Layered by design:** within the ledger, the explicit uniqueness checks and the SQLite key constraints back each other (mutated together); the preimage digest and the explicit `Sequence`/`Fee`/LLS comparisons back each other (each guard isolates one).

## 15. Residual risks and prerequisites

- **Residual:**
  - compromise of the signer process or delegate key;
  - Host compromise (AA-010);
  - the post-issuance revocation window (≤ capability lifetime);
  - an attacker controlling both the credential and the channel can race the Host for the one authorized blob;
  - signer-ledger rollback: the ledger file's integrity depends on the signer host; deleting rows or restoring an older copy re-enables still-unexpired capabilities (≤ 60 s), and nothing anchors the ledger externally;
  - P11 execution identity is Host-attested, not independently proven;
  - customer signers must implement v2 faithfully;
  - EP-073 stays DEPLOYMENT-GATED.
- **TRADE-04D:** reconcile `consumed` capabilities without a hash after a signer crash (the execution is never re-signed); recover from a capability that was consumed but whose order was not submitted.
- **TRADE-05:** a live Testnet run with a customer-operated v2 signer and external authority custody offering the extension.

## 16. Validation and verdict

All runs: 2026-10-15, this WSL2 machine, worktree on `/mnt/c`, Node v22.23.1.

| Check | Result |
|---|---|
| Typecheck, build, lint (Node16 imports, architecture, public surface) | pass |
| S1 suites (`trade04c-s1-capability`, `-signer-authorization`, `-host`, `-mutation`) | 43 + 39 + 6 + 32 = **120 / 120** |
| TRADE-04B suites | **266 / 266** |
| TRADE-04C suites (incl. Scenarios A–F on the shipped Host) | **160 / 160** |
| Focused (TRADE, CORE-02 authority and custody, bounded grants, CORE-07, P11/P12, NO_BYPASS, Payment PAY-0x, XRPL transport and rails) | 2 698 tests: 2 693 pass, 4 fail, 1 skipped. Three were structural pins of this change (PAY-04 CORE-naming list, TRADE-04A edge file list, transport importer list), updated with explicit notes; one was the separate-process test timing out under load. The four affected files were then rerun: **90 / 90**. |
| Full root suite (`npm run test:root`) | **11 993 tests: 11 977 pass, 3 fail**, 9 skipped, 4 todo |
| — the 3 failures | (1) `tests/external-authority-signer-launcher.test.mjs`: the known launcher deadline under load, recorded at TRADE-04A/B/C; passes alone (2/2). (2) `trade03-governed-risk-host` SEC-TRADE03-06: a load-dependent timing failure; passes alone (43/43, with the launcher file). (3) The S1 separate-process test: a signer restart under load outlived the 30 s capability, which the signer correctly refused as *expired* rather than *consumed*. The test now issues a 60 s capability and accepts expiry only when the restart demonstrably outlived it; 39/39 after the fix. **The full root suite was not rerun after this final test fix**; only that suite was. |
| Workspaces | **1 103 / 1 103** |
| Release coherence (manifest + API freeze) | pass |
| Protocol tarball (CI's steps) | built from pinned `eec79cdd`; matches the lock (sha256 `b0d6ee6f…`); isolated validation: every step ok, including test |
| Publishability | pass |
| Clean-room consumer | pass |

**Verdict: READY FOR PR** as the R1 credential-theft closure. The design was approved at the gate; the implementation is validated; nothing failed that does not pass alone.

It is **not** a production-readiness claim. That still requires:
- a customer-operated v2 signer with real key custody;
- external authority custody offering the extension;
- TRADE-04D recovery;
- TRADE-05 live qualification.

EP-073 stays DEPLOYMENT-GATED; NO_BYPASS remains 12 of 74.
