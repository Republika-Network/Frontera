# G-02B — Trusted Execution Capability Issuance: Security Statement

**Design:** `docs/architecture/ADR-EXECUTION-CAPABILITY-ISSUANCE.md`
**Invariants:** SEC-INV-367 … SEC-INV-374 (`SECURITY_INVARIANTS.md` §4.39)
**Profile:** the qualified single-organization secure Host. The issuance ledger is a **reference** record: not anchored against rollback (§5).

## 1. What G-02B ships, and what it does not

| Ships | Does not ship |
|---|---|
| the in-custody issuance rule and policy (`authority-authenticity/execution-capability-issuance.ts`) | a caller in the execution path, presentation or delivery (G-02C) |
| `signExecutionCapability` on the software signer and as an external custody extension | a route, response field, adapter header or public export |
| the Host issuer, write-once slot and durable issuance ledger (`execution-capability-issuance/`) | online status (G-02D), delegation, status-required issuance |
| the opt-in `executionCapabilities` Host section and composition | anti-rollback anchoring of the issuance ledger |

No Kernel, CORE-07, G-02A wire contract, existing schema, v1 route, P11/P12, TRADE-04C-S1 or rail change. No new dependency or trust root.

## 2. Custody: what is verified independently, and what is not

The custody boundary (software signer in-process, or the external service in its own process) verifies with its **own** key, clock and policy: the grant's signature and digest, the grant reference (binding grant id, digest and store), organization, subject, action, resource, the execution id's derivation from the grant's request and decision, the grant's expiry, the capability window, issuer, trust domain, audience registration, permitted action and binding format, and the fixed terms (single use, offline-permitted, no delegate). It signs only G-02A's signing bytes of the frozen canonical record it accepted.

**Containment is narrow.** Custody compares the capability with the grant on action, resource, organization, subject and execution only. It does not see what the action-binding digest commits to, and it does not compare the grant's amount, counterparty, parameter, action-class, resource-class or Governance Profile bounds — the capability has no such fields. So a party able to ask custody (a compromised Host, or a holder of the external custody credential) can obtain a valid capability for *any* request within one action and resource of an unexpired grant it holds the signed record of. The G-02C caller must bind only a request the governed exercise already admitted within the grant's bounds (G02B-R5).

It does **not** prove current non-revocation (D4). The Host issuer refuses a revoked grant through the authenticated store read just before reserving. A revocation committed after that read — including while custody signs — is not observed; the capability's window (≤ 60 s, 30 s default) bounds the exposure. An offline executor never observes a revocation; G-02B claims no instant revocation.

Under **software custody** the policy and key live in the Host process (AA-001): "independent" enforcement there protects against Host bugs, not a compromised Host. Under **external custody** the service's own policy file and key bound what a compromised Host can obtain — but the service is stateless (§5).

## 3. Issuance and recovery failure matrix

| Point | Ledger | Custody | Caller sees | Reissue? |
|---|---|---|---|---|
| Malformed input, signer lacks the operation, ledger unreadable | — | never asked | `never-requested` | yes (nothing exists) |
| Execution already in the ledger | unchanged | never asked | `CAPABILITY_ALREADY_ISSUED` / `CAPABILITY_OUTCOME_UNKNOWN` | **no** |
| Grant absent, unreadable, revoked | — | never asked | `never-requested` | yes |
| Local rule refuses (forged grant, wrong audience, action, resource, organization, derivation, expiry, lifetime, stale registry) | — | never asked | `CAPABILITY_REFUSED` (+ rule) | yes, if the cause changes |
| Reservation not durable (lock, I/O) | — | never asked | `CAPABILITY_LEDGER_UNAVAILABLE` | yes |
| Concurrent reservation lost | the winner's row | never asked | `CAPABILITY_OUTCOME_UNKNOWN` | **no** |
| Custody refuses, times out, transport fails | `uncertain` | possibly signed | `CAPABILITY_SIGNING_UNCERTAIN` | **no** |
| Signature does not verify under the active key | `uncertain` | possibly signed | `CAPABILITY_SIGNATURE_INVALID` | **no** |
| Crash after reservation | `reserved` | unknown | (restart) `CAPABILITY_OUTCOME_UNKNOWN` | **no** |
| Crash after signature, before commit | `reserved` | signed | `CAPABILITY_RECORD_FAILED`; restart: outcome unknown | **no**; the signed artifact is never released |
| Signed, verified, committed | `issued` | signed | the capability | **no** (delivery is G-02C) |

"No reissue" includes re-signing the same bytes: the external client sends a capability request once, and the issuer never retries.

## 4. Privacy: what the per-capability grant reference hides

**Construction.** `sha256` over `aoc.canonical-json.v1` of `{domain: …grant-reference.v2, nonce, grantStoreId, boundedGrantId, grantDigest}` with a fresh 32-byte random nonce per capability. Custody recomputes it from the grant it verified and the nonce; the Host keeps the nonce in the issuance ledger for evidence linking. The nonce is not in the capability.

**Stated attacker:** an executor, or colluding executors, holding capabilities — possibly also holding grant identities from elsewhere (the S1 delegated-signer requests carry `grantStoreId`, `boundedGrantId` and `grantDigest`; database readers, backups and evidence handlers see them too).

**What it prevents.** Under G-02A's v1 value anyone knowing a grant's identity can confirm which grant a capability derives from by recomputing it. Under v2 that confirmation requires the nonce; without it, the reference is a hash of a 256-bit unknown value and reveals nothing about the grant (computational hiding, standard assumptions on SHA-256). Two capabilities for one grant carry different references.

**What it does not prevent — stated plainly.**
- **The execution id links capabilities of one grant anyway.** Custody pins the execution id to the grant's request and decision, so every capability derived from one grant names the same `executionId` (the only way to obtain two is the D7 duplicate). The reference adds no unlinkability between them.
- `subjectActorId`, `action`, `resource`, `audience`, the binding digest and timing correlate capabilities across grants exactly as before (G02A-R5).
- **The nonce is not a secret key.** It is stored in plaintext in the Host's issuance ledger (and every backup of it) and travels in the custody request (to the external service, over its transport — plain HTTP on loopback for the reference service). Whoever reads either can confirm that capability's grant link. Its confidentiality is that of the ledger and the custody channel; nothing more is claimed.

**Key custody implications:** none. No key, MAC secret or new trust root is introduced; the nonce authenticates nothing.

## 5. D7 — rollback and duplicate issuance

**Modelled** (`g02b-execution-capability-issuance-ledger.test.ts`, `g02b-execution-capability-issuer.test.ts`): the issuance ledger is restored from a copy that predates an execution's issuance. The Host reserves again — same execution id, a **different capability id, a different nonce and a fresh valid signature** — and custody signs it.

| Boundary | Effect on the duplicate |
|---|---|
| Issuance ledger | none: the restored file has no row; integrity checks pass (it is a genuine older ledger) |
| Custody rule | none: it is stateless; it still pins the duplicate to **the same execution**, the same grant, audience policy and lifetime |
| Grant store (CORE-01/07) | refuses only if the grant is revoked or expired; the grant lifetime (≤ 3600 s) bounds when a duplicate can be minted |
| G-02A executor ledger, one consumption domain | **refuses** the duplicate: `EXECUTION_CONSUMED` (`UNIQUE(issuer, execution_id)`) |
| Separate consumption domains (separate executor ledger files, or another audience registered for the action) | **accept** it: a second execution is possible within the window |

The same holds for two Host processes configured with different issuance-ledger files, and — without any rollback — for in-process code or a holder of the custody credential calling custody directly (AA-010): custody is stateless, so it would sign further capabilities for that grant's one execution. These are the accepted reference profile and the existing CORE-02 caveat; no additional authority path was found.

**Deployment blocker.** No strong production guarantee of globally unique issuance per execution may be claimed until an authoritative anti-rollback strategy for the issuance ledger (for example CORE-07 anchoring of its head) is approved. G-02B does not implement one and claims no exactly-once property.

## 6. Adversarial coverage

| Threat | Result | Test |
|---|---|---|
| Forged grant (untrusted key), grant signed by another trusted key, unsigned, rewritten after signing, foreign store id | refused in custody (`GRANT_SIGNATURE_INVALID` / `GRANT_MALFORMED`) | `g02b-execution-capability-custody.test.ts` |
| Wrong custody key / issuer / issuer key id; key rotation (grant under former key) | refused; G-02A overlap still verifies issued capabilities | same |
| Foreign organization or trust domain (capability or grant) | refused | same |
| Unregistered or wildcard audience; action or binding format not permitted | refused (rule and policy validation) | same; issuer suite |
| Action or resource mismatch; execution not derived from the grant | refused | same; Host suite |
| Revoked, expired, absent grant | refused before reservation | issuer suite (double and real SQLite store) |
| Lifetime above policy, outliving or preceding the grant, clock skew | refused | custody suite |
| Signature or domain substitution (grant ↔ capability, every field changed) | refused | custody suite |
| Nonce or reference mismatch; G-02A v1 reference | refused | custody suite |
| Repeated execution; concurrent issuance (in process, two connections, four threads) | one reservation, one custody call | issuer and ledger suites |
| Tampered (triggers dropped) or missing ledger; foreign issuer; stripped triggers; other schema | refused | ledger suite |
| Signing failure, unverifiable signature, crash after reservation, crash after signature | `uncertain` / `reserved`; never reissued | issuer suite |
| Invalid or stale trust configuration (verifier without the active key; policy errors; ledger of another issuer) | refused | issuer, custody, Host suites |
| Signer extension abuse: re-spaced text, extra key, bad nonce, missing grant signature, generic path | not a request; no generic path | custody and structure suites |
| Rollback | modelled (§5) | ledger and issuer suites |
| Software custody, in-process HTTP reference service, separate launcher process | each qualified | custody suite |
| S1 and the five core operations | unchanged | custody and structure suites; existing S1 suites |
| Removal of each load-bearing control | 28 mutants detected | `g02b-execution-capability-mutation.test.ts` |

## 7. Residual risks

| ID | Risk | Owner |
|---|---|---|
| G02B-R1 | Issuance ledger not anchored against rollback; a restored or duplicated ledger permits a second capability for one execution (§5) | **deployment blocker** for strong production claims; anti-rollback strategy (founder) |
| G02B-R2 | Custody does not prove current non-revocation; revocation after the Host's read is bounded only by the window; offline executors never observe it | G-02D (status); short windows |
| G02B-R3 | Custody is stateless: in-process code or a custody-credential holder can obtain more capabilities for a grant's one execution (AA-010), bounded by grant lifetime and per-domain execution uniqueness | CORE-02 custody hardening |
| G02B-R4 | The grant-reference nonce is plaintext in the Host ledger and in custody requests; the execution id and subject correlate capabilities regardless (§4) | documented |
| G02B-R5 | Containment at issuance is action, resource, organization, subject and execution only: the action-binding digest (the request) comes from the in-process caller and the grant's amount, counterparty, parameter, class and profile bounds are not compared — custody bounds the binding's format, not its content | G-02C0 binds only the frozen request the governed exercise admitted (`G-02C0-GOVERNED-EXECUTION-BINDING.md`); custody-side containment remains open |
| G02B-R6 | Under software custody the policy and key share the Host process (AA-001) | external custody |
| G02B-R7 | `uncertain` and `reserved` are terminal: an execution whose custody call failed never receives a capability (availability) | reconciliation / operator |
| G02B-R8 | No ledger-initialization tool; an operator initializes the ledger by a library call | G-02C / operations |
| G02B-R9 | A reservation that cannot take the write lock within the busy timeout is refused (`CAPABILITY_LEDGER_UNAVAILABLE`, nothing requested) | fail closed |
| G02B-R10 | The ledger's trigger check on open is by name; a raw writer could substitute a same-named no-op trigger (per-row re-derivation still refuses tampered rows) | as G-02A; host file protection |
| G02B-R11 | `issuedAt` may lead custody's clock by 5 s, so from custody's view a capability may stay valid ≈ 65 s (≤ 60 s from its own `issuedAt`) | documented |
| G02B-R12 | `AuthorityArtifactVerifier` (a publicly exported type) gains a required `verifyExecutionCapability`, and `AuthorityArtifactSigner` an optional `signExecutionCapability`: an embedder implementing the verifier interface by hand must add the method (runtime behaviour of every existing operation is unchanged) | release note |
