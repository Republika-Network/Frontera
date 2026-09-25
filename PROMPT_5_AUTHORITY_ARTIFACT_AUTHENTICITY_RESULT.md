# Prompt 5 — Introduce Cryptographic Authenticity for Authority Artifacts — Result

- Track: Security & Containment Architecture, Prompt 5.
- Canonical artifact: `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md`.
- Base: `main` @ `30b627a` (Prompts 0, 1, 2, 2.5, 2.6, 3 and 4 all merged).
- Branch: `claude/adoring-cray-hp0qfo` — **harness-mandated**, diverging from the prompt's preferred `claude/frontera-authority-authenticity`. Reported rather than silently substituted.
- Production behaviour changed: **YES** — see §8.

---

## 1. What this prompt owned

Prompt 4 hardened the bounded-grant store and left exactly one finding open by construction. **GS-001**: the record digests are unkeyed, so a privileged writer can rewrite a grant and recompute them. Its guarantee was *"these bytes are internally consistent"*, never *"these bytes were authorized by a trusted issuer"*.

This prompt adds the second property, for `BoundedGrant` and `GrantRevocation`, and nothing else. It is not a PKI project and no other signing scheme in the repository was redesigned.

## 2. The distinction the design is organised around

| Mechanism | Who can produce a valid one | What it proves | Decision |
|---|---|---|---|
| Unkeyed digest | anyone | the bytes are the bytes that were digested | **retained** — it catches corruption with no key present |
| MAC / HMAC | anyone who can *verify* | a shared-secret holder wrote this | **refused** |
| Digital signature | only the private-key holder | a trusted authority key vouched for these exact bytes | **added** |

The middle row is why the design is asymmetric. An HMAC would authenticate, but every party able to *check* authority would also be able to *mint* it — precisely the property the read path must not have. The repository's existing Agent Passport signer is HMAC-based; it was read, contrasted, and deliberately **not** reused. Standardising by lowering this boundary to match it would have been a regression dressed as consistency.

## 3. What was built

| Component | Path |
|---|---|
| Envelope, closed algorithm registry, domain separators, canonical signing bytes | `src/enterprise/authority-authenticity/authority-signature.ts` |
| Signer interface + software (process-resident) signer | `src/enterprise/authority-authenticity/signer.ts` |
| Verifier interface + trusted key registry | `src/enterprise/authority-authenticity/verifier.ts` |
| Failure taxonomy | `src/enterprise/authority-authenticity/errors.ts` |
| Verification on the authoritative read; signature persistence | `src/enterprise/bounded-grant-store/sqlite-bounded-grant-store.ts` |
| Separate signer/verifier construction | `buildAuthorityAuthenticity` in `src/enterprise/composition/composition-root.ts` |
| Configuration + redaction | `src/enterprise/configuration/enterprise-configuration.ts` |

**Ed25519**, via Node's standard library. No new dependency. Chosen because it is asymmetric, deterministic, and — the property that decided it against the alternatives — `crypto.sign(null, …)` takes **no hash parameter**, so there is no digest field an artifact could influence and the "sign with something weaker" family of downgrades has nowhere to attach.

### 3.1 Where the signature attaches, and why there

Prompt 4's handoff named the attachment point exactly, and it was followed as written: a detached signature over `serializeStoredGrantRecord` / `serializeStoredRevocationRecord`, in columns beside each digest, verified in `verifiedGrant`, `verifiedRevocation` and `currentRevocation`. The control flow needed no change because those three sites already failed closed.

The signature lives in the **persisted envelope**, not on the `BoundedGrant` artifact. That was a decision, not the easiest schema patch: `bounded-grant.ts` is emphatic that a grant is "not a JWT, macaroon, UCAN, OAuth token, signed URL, capability token or ledger object" and that "a caller never holds one and therefore never presents one". Putting a signature envelope on the artifact would have started turning it into a bearer token, contradicting an accepted ADR. The artifact is never transported outside the trusted store, so authenticity does not need to travel with it. If grants ever become portable, the envelope must travel too — recorded in the canonical document.

Signing over the *record envelope* rather than the grant alone buys one thing worth naming: the envelope binds the grant id and the schema version, so a signature lifted onto a different row fails. Tested.

### 3.2 The commit-guard race, analysed rather than assumed away

A signer call cannot run inside a synchronous `better-sqlite3` transaction, and holding one open across a network call would make signer availability into store availability. So signing happens **before** the transaction opens — which raises the only question that matters: can eligibility change while the signer works?

It cannot. `commitGuard` still runs **inside** the transaction, **after** signing, immediately before the insert, so the window is re-checked at its far end. The guard's type is unchanged — still synchronous, so no `await` can interleave. A test observes the ordering and asserts `sign` precedes `guard`. A signature over a grant that is then refused is discarded: **authority is a committed row, not a signature someone holds.**

## 4. Storage-backend scope — a decision, stated

Authenticity applies to the **durable** store. The in-memory store is unsigned, and that is deliberate rather than unfinished: signing buys something precisely because the storage medium sits *outside* the process trust boundary — a file a DBA can write, a backup, a replica. An attacker who can write the in-memory `Map` is already inside the process and can read the private key or call the adapter directly, so signatures there would protect against nothing that is not already lost.

This is not an unsigned *fallback*: the durable store has no unsigned mode at all, a deployment picks one backend at composition, and choosing in-memory means choosing authority that dies with the process — already documented as fail-closed. The semantics are identical in both ("authority state is returned only if it is trustworthy"); what differs is what "trustworthy" can mean on a medium inside versus outside the boundary.

## 5. Twenty-two authenticity invariants

AA-INV-001 … AA-INV-022, each with an enforcement mechanism and a test. Full table in `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §5. AA-INV-021 (trust never taken from the artifact) and AA-INV-022 (a signer failure never becomes an unsigned write) are additions beyond the prompt's list, required by what the source does.

Recorded in `SECURITY_INVARIANTS.md` as **SEC-INV-039**.

## 6. Findings

| ID | Severity | Title | Owner |
|---|---|---|---|
| **AA-001** | **HIGH** | The authority signing private key is resident in application process memory | **Prompt 6** |
| **AA-002** | MEDIUM | The trusted verification registry is deployment-controlled configuration | deployment |
| **AA-003** | MEDIUM | Signatures carry no freshness; snapshot rollback restores validly-signed artifacts | unowned |
| **AA-004** | MEDIUM | Signer availability is required to **revoke** | Prompt 6 / 12 |
| **AA-005** | LOW | Every issuance and revocation attempt invokes the signer, refused ones included | Prompt 6 |
| **AA-006** | LOW | One algorithm registered; adding a second is deliberate code work | Prompt 6 |

### Inherited

- **GS-001 — CLOSED for a database-only writer.** A writer with database access and no signing key can alter a record, recompute every unkeyed digest, and still produce nothing the read path returns. **Still open** for a writer holding the signing key (AA-001) or the key configuration (AA-002).
- **GS-002 — STILL OPEN, NOT ADDRESSED.** Signatures authenticate; they do not timestamp. Restated as AA-003.
- **NB-009 — NOT fully closed.** *In-memory* and *singly implemented*: closed by Prompt 4. *Unkeyed*: closed for the durable store here. But "authority the application cannot forge" is **not** yet true, because the key is process-resident.
- **NB-006, NB-008 — unchanged.** No consumption model added; a signature still says nothing about whether the policy that produced a grant was legitimate.

## 7. A note on one finding discovered while testing

A test that expected a private key to be refused from the verification registry initially failed: `crypto.createPublicKey()` accepts a **private** key and silently derives the public half. A deployment that pasted the wrong half into the trusted set would have worked perfectly and never been told — while publishing a private authority signing key on `PublicEnterpriseConfiguration`, a surface designed to be safe to expose. The registry now rejects private-key PEM text *before* parsing, because after parsing the evidence is gone. The test that found it is kept.

## 8. Production behaviour change

**AUTHENTICITY ENFORCEMENT: MANDATORY** for the durable store. **PRIVATE SIGNING KEY: PROCESS-RESIDENT.**

| Composition | Before | After |
|---|---|---|
| Host supplies `grantStore` | that store | unchanged |
| No `grantStore`, `persistence.provider === 'memory'` (the default) | in-memory | unchanged — no keys needed, no signing |
| No `grantStore`, `persistence.provider === 'sqlite'` | durable store | durable store, **signing and verification required**; composition **refuses** if keys are unconfigured |
| An existing `aoc.bounded-grant-store.schema.v1` database | opened | **refused at open**, not migrated and not auto-signed |

A deployment on the default in-memory provider sees **no change**. A deployment that had adopted the durable store must configure three environment variables and start from a fresh database. Both are startup-visible, both fail closed, and neither is hidden: `.env.example` documents the variables and the key-generation command.

There is **no** flag that disables verification, and no `enabled` field on the configuration. That is deliberate — an optional security path becomes a permanent downgrade seam — and a structural test pins it.

## 9. Tests

| Suite | Result |
|---|---|
| `npm run build` / `npm run lint` | pass (34 pre-existing `TS5101` tsconfig deprecation errors, present identically on `origin/main`; **zero** new type errors) |
| `npm run test:root` | **5590 / 5590** (was 5522; +68) |
| `npm run test:workspaces` | **1030 / 1030** |
| New: `authority-artifact-authenticity.test.ts` | 43 |
| New: `authority-authenticity-boundaries.test.ts` | 25 |
| Prompt 4's `bounded-grant-store-durability.test.ts` | **28, unmodified except for the store constructor** — the Prompt 4 revalidation |

Covered: the privileged-DB-writer forgery (the central test), cross-artifact substitution, key rotation across three eras, restart, signer failure on both paths, configuration refusal, and the separation of signing from verification.

### 9.1 Non-vacuous validation

Six deliberate violations, each built, run, and reverted byte-for-byte:

| Violation | Failures | Caught by |
|---|---|---|
| Bypass grant signature verification | **10** | the central forgery test, substitution, rotation, restart, and the structural "verifies on every read" rule |
| Unknown key id falls back to a trusted key | 1 | "an unknown keyId fails closed" |
| Artifact supplies its own public key | 1 | "the envelope type has no field a public key could travel in" |
| A missing signature verifies | 1 | "a missing signature fails closed" |
| Exercise runtime imports a signer | 1 | "the execution runtime names no signer" |
| Grant and revocation share one signing domain | 1 | "the two signing domains differ" |

The last is the most instructive. Collapsing both domains left the *cross-artifact confusion tests passing*, because the record JSON still differs (`"kind":"grant"` vs `"kind":"revocation"`). Shape alone would have been an accidental property, dependent on two serializers continuing to disagree — which is exactly why the prompt requires explicit domain separation, and why the test that asserts the constants differ earns its place.

## 10. Prompt 3 and Prompt 4 revalidation

**Prompt 3 — EP-011 remains PROVEN — PATH LOCAL, not widened.** Re-verified from source: single adapter call site, authoritative reread per attempt, no cache, caller supplies only an id, adapter invoked after the assessment. Verification is synchronous and runs *inside* the read, so no step was inserted between the read that decides and the adapter call.

**Prompt 4 — preserved.** The synchronous `commitGuard` type, durable revocation at durability equal to the grant's, transactional atomicity, restart monotonicity, fail-closed corruption detection, no sweeper, the two-record cross-check, revocation idempotency with the first revocation standing and never re-dated, and the absence of any consumption model. The evidence is that all 28 durability tests pass unmodified.

## 11. What is not claimed

Tamper-proof authority · "host compromise cannot forge authority" · anti-rollback · "the signing key cannot be stolen" · "the application process cannot access signing material" · KMS/HSM · "all Frontera authority artifacts are signed" · "signatures replace the digests" · "key rotation revokes grants". Each row carries its counter-evidence in `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §24.

## 12. Handoff to Prompt 6

The signer is already an injected boundary with an `async`, domain-aware interface that returns no key material, so a KMS/HSM adapter replaces the implementation without touching a call site. Two signing call sites, both outside the transaction. `createPrivateKey` appears in exactly one production file, pinned by a structural test.

Three things Prompt 6 must carry forward, in `AUTHORITY_ARTIFACT_AUTHENTICITY.md` §25: **verify the target provider actually supports Ed25519** (several managed KMS products offer only ECDSA/RSA, and the closed registry exists so a second entry is deliberate work rather than negotiation); **preserve the sign → BEGIN → commitGuard → INSERT → COMMIT order**, because a KMS call inside the transaction is both a correctness and an availability regression; and **keep verification local**, so a KMS outage stops issuance but not reads.

The target invariant — *no production authority-signing private key is resident in application process memory* — is **FALSE today**, and `SEC-INV-U02` stays NOT IMPLEMENTED until it is true.
