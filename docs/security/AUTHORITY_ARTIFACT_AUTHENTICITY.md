# Authority Artifact Authenticity

- **Track:** Security & Containment Architecture, Prompt 5.
- **Scope:** the authority artifacts the bounded-grant execution path trusts — `BoundedGrant` and `GrantRevocation` — and nothing else.
- **Status:** implemented for the durable bounded-grant store. Signing key **process-resident** (AA-001); Prompt 6 owns that boundary.
- **Predecessor:** `AUTHORITATIVE_GRANT_STORE.md` (Prompt 4).

---

## 1. Purpose

Prompt 4 made the bounded-grant store durable, transactional and fail-closed, and protected every persisted record with an unkeyed SHA-256 digest recomputed on each authoritative read. It stated its own ceiling plainly:

> Digest integrity is not cryptographic authenticity. These digests are unkeyed. Anyone who can write a record can recompute its digest.

That left one finding open by construction — **GS-001**: a privileged writer can alter persisted authority and re-seal it, because the sealing recipe is unkeyed and is in this repository.

This document records the mechanism that closes it for a database-only writer, and states precisely what it does not close.

## 2. Security Property

The property added is this, and only this:

> A persisted bounded grant or grant revocation is not returned as authoritative unless a **detached Ed25519 signature over its canonical bytes verifies against a public key drawn from a trusted, composition-supplied registry**.

Three consequences, each of which is a separate claim:

1. Altering the database and recomputing every unkeyed digest is **no longer sufficient** to manufacture usable authority.
2. Verification requires **public material only** — the reading path can check authority it cannot mint.
3. Signing capability and verification capability are **separate types**, so a component can be handed one without the other.

### 2.1 The three mechanisms, kept distinct

The single most important distinction in this document:

| Mechanism | Who can produce a valid one | What it proves | Used here for |
|---|---|---|---|
| **Unkeyed digest** (SHA-256) | anyone | these bytes are the bytes that were digested | corruption, partial writes, casual mutation — **retained** |
| **MAC / HMAC** (shared secret) | anyone who can *verify* | a holder of the shared secret wrote this | **deliberately not used** — see §10.4 |
| **Digital signature** (Ed25519) | only the private-key holder | a trusted authority key vouched for these exact bytes | authenticity — **added by this prompt** |

The middle row is the one that matters architecturally. A MAC would authenticate, but every party able to check authority would also be able to mint it — which is exactly the property the bounded-grant read path must not have. That is why the design is asymmetric, and it is why the repository's existing Agent Passport HMAC signer was evaluated and **not reused** (§10.4).

## 3. Relationship to Prompt 4

Prompt 4's mechanisms are **retained, not replaced**. Digests and signatures answer different questions and both are still asked, in a fixed order:

| Question | Answered by | Still present |
|---|---|---|
| Are these the bytes that were written? | `storedGrantRecordDigest`, `storedRevocationRecordDigest`, `boundedGrantDigestMatches` | yes |
| Is this row filed under the identity it claims? | `grant.id === row.grant_id`, envelope digest | yes |
| Was this record written under a schema this runtime implements? | `row.schema_version` check | yes |
| Do the grant and its revocation agree? | the two-record cross-check | yes |
| **Did a trusted authority key vouch for these bytes?** | **this document** | **new** |

A digest failure is still reported as corruption; only a signature failure is reported as an authenticity failure. Both refuse. Neither repairs.

Every Prompt 4 store semantic is unchanged: the synchronous `commitGuard` type, the per-read authoritative reread with no cache, the reader-port narrowing on the exercise path, the absence of any sweeper, the two-record cross-check, the absence of any consumption model, and the fail-closed direction of every refusal. §15 and the 28 unmodified Prompt 4 durability tests are the evidence.

## 4. Artifact Inventory

Reconstructed from source before any code was written.

### 4.1 `BoundedGrant`

| Field | Authority-relevant | Covered by the signature |
|---|---|---|
| `id` | identity | yes |
| `correlation` (`requestId`, `decisionId`, `action`, `resourceScope`) | what it derives from | yes |
| `subject` | who may exercise | yes |
| `scope` (every bound axis) | the bounds | yes |
| `issuedAt` | validity window | yes |
| `expiresAt` | validity window | yes |
| `sourceDigest` | provenance of the narrowed-from authority | yes |
| `digest` | the artifact's own unkeyed digest | yes — signed as data, see §8.3 |

There is **no** token, no lifecycle status field, no usage counter, and (before this prompt) no signature field anywhere on the artifact.

### 4.2 `GrantRevocation`

| Field | Authority-relevant | Covered |
|---|---|---|
| `grantId` | which grant | yes |
| `revokedAt` | when it stopped being exercisable | yes |
| `reason` | closed seven-value vocabulary | yes |
| `issuerRef` | who recorded it | yes |

### 4.3 Evidence table — the state before this prompt

| # | Question | Finding |
|---|---|---|
| 1 | Canonical serialization | `serializeBoundedGrant` (lexicographic, no whitespace, `aoc.canonical-json.v1` rules) |
| 2 | Grant artifact digest | `boundedGrantDigest` — unkeyed SHA-256, `digest` held empty |
| 3 | Record-envelope digest | `storedGrantRecordDigest` / `storedRevocationRecordDigest` — unkeyed SHA-256 |
| 4 | Where digests are created | `grant-issuance-service.ts` (artifact), `sqlite-bounded-grant-store.ts` (envelope) |
| 5 | Where digests are verified | `verifiedGrant`, `verifiedRevocation`, `currentRevocation` — all inside the read transaction |
| 6 | Any signature field? | **none anywhere** |
| 7 | Does `issuerRef` identify a key? | **No.** A free-text operator/system label. It is *not* a cryptographic identity and was not repurposed as one |
| 8 | Is `sourceDigest` authenticity? | **No.** Unkeyed provenance — "narrowed from what?" — with no key involved |
| 9 | Where grants are created | one place: `createGrantIssuanceService.issueGrant` |
| 10 | Where revocations are created | two: `GrantIssuanceService.revokeGrant` and the store's `revoke` |
| 11 | Where artifacts enter/leave storage | `issue`, `read`, `revoke` on both store implementations |
| 12 | Revocation integrity before Prompt 4 | none at all (NB-009) |

A note on #7, because it is the kind of thing that gets quietly conflated: `issuerRef` says *who an operator claims recorded a revocation*. `keyId` says *which key produced a signature*. They are unrelated, they are not checked against each other, and `issuerRef` remains unauthenticated free text that happens to be **covered by** the signature — signed as data, never treated as identity.

## 5. Authenticity Invariants

| ID | Invariant | Enforced by | Test |
|---|---|---|---|
| **AA-INV-001** | A durable grant is not returned as authoritative unless its signature verifies against a trusted key | `verifiedGrant` throws | reseal-forgery, random-signature, attacker-key |
| **AA-INV-002** | The same for a durable revocation | `verifiedRevocation` throws | revocation-reseal |
| **AA-INV-003** | Verification requires only public material | `verifier.ts` imports no `createPrivateKey` | structural: `createPrivateKey` confined to the signer |
| **AA-INV-004** | The exercise/runtime path has no signing capability | `BoundedGrantReaderPort`; execution runtime names no signer | structural: execution runtime forbidden patterns |
| **AA-INV-005** | Every signed artifact identifies its key | `keyId` required in the envelope, `NOT NULL` column | envelope shape test |
| **AA-INV-006** | Every signed artifact identifies its algorithm and version | `algorithm` + `artifactVersion` required | envelope shape test |
| **AA-INV-007** | An unknown key id is unusable | registry lookup returns `AUTHORITY_SIGNING_KEY_UNKNOWN` | unknown-keyId test |
| **AA-INV-008** | An unsupported algorithm is refused | closed registry | algorithm-confusion test (5 values) |
| **AA-INV-009** | Missing, malformed or undecodable signature material yields no authority | shape check + strict base64url + exact width | missing / malformed / truncated tests |
| **AA-INV-010** | The signature is over deterministic canonical bytes | `grantSigningBytes` / `revocationSigningBytes`, one function per side | domain tests |
| **AA-INV-011** | Every authority-influencing field is covered | signature is over the full record envelope | 8-field mutation test |
| **AA-INV-012** | No unsigned fallback on a signed-store read | no branch skips verification; columns `NOT NULL`; no config flag | structural: exactly one verify call site each, no `authenticity?:` |
| **AA-INV-013** | Unkeyed digests remain, and are not treated as authenticity | both still checked, and checked first | digest-before-signature test |
| **AA-INV-014** | Verification happens before authority state is returned | inside `runRead`'s transaction, before the return | V1 violation caught by 10 tests |
| **AA-INV-015** | Unauthentic revocation state fails closed | `verifiedRevocation` throws; read refuses | revocation-reseal, lifted-revocation |
| **AA-INV-016** | Signing and verification are separate interfaces | two interfaces, neither extending the other | structural: distinct interfaces, distinct runtime members |
| **AA-INV-017** | Historical artifacts stay verifiable by key id after rotation | registry holds many keys; artifacts carry their own key id | rotation test |
| **AA-INV-018** | No algorithm confusion | closed registry; envelope algorithm must equal the registry's for that key | algorithm-mismatch path |
| **AA-INV-019** | Signing does not widen authority | signing is a separate step over an already-constructed artifact; no issuance check was removed | 28 unmodified Prompt 4 tests |
| **AA-INV-020** | Prompt 3's ordering is preserved | `read → assess → adapter` untouched | no-bypass suites unchanged |
| **AA-INV-021** | Trust is never taken from the artifact | envelope has no key field; no verification path reads one | structural: no TOFU, no envelope key field |
| **AA-INV-022** | A signer failure never becomes an unsigned write | `signGrantOrFail` has no branch that returns without a signature | signer-down issue/revoke tests |

AA-INV-021 and AA-INV-022 are additions beyond the prompt's list, both required by what the source actually does.

## 6. Signature Algorithm

**Ed25519**, registered as `ed25519-v1`.

| Criterion | Ed25519 |
|---|---|
| Asymmetric | yes — the requirement that drove the choice |
| Deterministic | yes; no entropy needed at signing time, so a failing RNG cannot silently weaken a signature |
| Caller-controlled hash parameters | **none.** `crypto.sign(null, …)` takes no hash argument; the algorithm fixes it internally. There is no digest field for an artifact to influence, so the "sign with something weaker" family of downgrades has nowhere to attach |
| Runtime support | Node standard library; `engines.node >= 22`, verified on v22 |
| New dependency | none |
| Signature width | fixed 64 bytes — so truncation is detectable as *malformed* before any key is consulted |
| Key import shape | PKCS#8 (private) / SPKI (public) PEM — what a KMS export produces |

**Rejected:** RSA (no existing key-management boundary requires it; larger keys, more parameters, more ways to misuse). HMAC (§10.4). Anything deprecated.

**Honest note for Prompt 6:** Ed25519 support is not universal across managed KMS providers — some offer only ECDSA (P-256/384/521) and RSA for asymmetric signing. The algorithm registry (§30 of the prompt; `SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS` in source) is closed and versioned precisely so a second entry can be added as deliberate code-and-configuration work if the chosen provider requires it. Adding one is not automatic and there is no negotiation, no fallback and no try-until-one-verifies.

## 7. Signature Envelope

```ts
interface AuthoritySignature {
  readonly algorithm: 'ed25519-v1';          // closed registry
  readonly keyId: string;                    // a CLAIM, resolved against trusted config
  readonly signature: string;                // base64url, unpadded, exactly 64 decoded bytes
  readonly artifactVersion: 'aoc.authority-artifact.v1';
}
```

Four fields, all required, no free-form metadata. What is **absent** is as load-bearing as what is present:

- **No public key, certificate, JWK or x5c.** An artifact carrying its own verification key would be its own root of trust — "this is signed, by whoever signed it" — which is not a security property. A structural test asserts the type declares no such field, and that no verification path reads one.
- **No signer-supplied timestamp.** The repository's Agent Passport signature carries `signedAt`; this one deliberately does not. A timestamp inside the envelope is unverifiable metadata that invites being read as evidence of when authority was granted, and the grant already carries `issuedAt` — signed, and derived from the issuance path rather than from the signer.

## 8. Canonical Signing Bytes

### 8.1 What is signed

```
grant:      "frontera:authority-artifact:bounded-grant:v1\n"   + serializeStoredGrantRecord(grant)
revocation: "frontera:authority-artifact:grant-revocation:v1\n" + serializeStoredRevocationRecord(revocation)
```

There is exactly **one** function producing each — signing and verification call the same one, so the two sides cannot drift.

### 8.2 Why the record envelope rather than the artifact alone

`serializeStoredGrantRecord` binds four things in one deterministic string:

```
{"format":"aoc.bounded-grant-store.record.v1","grant":<canonical grant>,"grantId":"<id>","kind":"grant","schemaVersion":"aoc.bounded-grant-store.schema.v2"}
```

So the signature covers every authority-relevant field **and** the identity the row is filed under **and** the schema version it was written by. A signature lifted onto a different row therefore fails — proven by the substitution tests — which a signature over the artifact alone would not have guaranteed.

### 8.3 Circularity — considered and avoided

`BoundedGrant.digest` is inside the signed bytes. That is not circular: `boundedGrantDigest` is computed over the grant with `digest` held empty, so the value is fully determined *before* signing. The signature covers it as ordinary data. The alternative — excluding it — would have left a field an attacker could move freely, so it is included deliberately.

The chosen model, stated as a chain:

```
canonical authority payload
    ↓
unkeyed artifact digest        (corruption/provenance; retained)
    ↓
record envelope (+ id, schema version, format)
    ↓
unkeyed envelope digest        (corruption; retained)
    ↓
domain separator + envelope  →  Ed25519 signature   (authenticity; new)
```

## 9. Domain Separation

Two mechanisms, deliberately redundant:

1. **An explicit literal byte prefix**, different per artifact type, newline-terminated so prefix and payload cannot be re-split.
2. The payload's own `"kind":"grant"` / `"kind":"revocation"` field.

The prompt's rule — *do not rely only on JSON shape* — is why (1) exists. The deliberate-violation experiment is the evidence it is doing work: collapsing both domains to one string left the cross-artifact confusion tests **passing**, because the payload JSON still differed, and was caught only by the test that asserts the two domain constants differ. Shape alone would have been an accidental property, dependent on two serializers continuing to disagree. The prefix makes separation a property of the signing input itself.

## 10. Signer Boundary

### 10.1 Interface

```ts
interface AuthorityArtifactSigner {
  readonly activeKeyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  signGrant(grant: BoundedGrant): Promise<AuthoritySignature>;
  signRevocation(revocation: GrantRevocation): Promise<AuthoritySignature>;
}
```

**Domain-aware, never generic.** There is no `sign(bytes)`. A generic byte-signing capability would let any holder produce a signature over bytes of its own choosing — for a key whose meaning is "this artifact is authoritative", that is the ability to mint authority in a shape the signer has never seen. Least authority applies to a crypto API exactly as it applies to a store port. A structural test asserts the interface exposes no raw signing operation.

### 10.2 Why `async`

Nothing about in-process Ed25519 needs to be asynchronous. The interface is `Promise`-returning so that (a) Prompt 6 can substitute a KMS/HSM call without changing a call site, and (b) — more importantly — every caller is *already written* to tolerate a signer that takes time. §14.1 explains why that makes the commit ordering safe rather than merely convenient.

### 10.3 The implementation, named honestly

`createSoftwareAuthorityArtifactSigner` holds a **private key in application process memory**, loaded from configuration. It is not a hardware boundary, not a KMS, not an HSM. Recorded as **AA-001**. The key is parsed once into a `KeyObject` held in a closure: never returned, never placed on the object, never serialized into a record, never logged, and never included in an error message — the parse failure paths discard the underlying error precisely because it can quote the material it failed to parse.

### 10.4 The existing Agent Passport signer — evaluated, not reused

`packages/agent-governance/src/signing/` provides `AgentPassportSignerPort` with an HMAC-SHA256 implementation. It was examined and deliberately not reused:

| | Agent Passport signer | This boundary |
|---|---|---|
| Construction | HMAC-SHA256 | Ed25519 |
| Key model | shared secret | asymmetric key pair |
| Can a verifier mint? | **yes** | no |
| Interface | `sign(payload: string)` — generic bytes | domain-aware, per artifact type |
| Envelope | includes signer-supplied `signedAt`, `issuer` | key id, algorithm, version only |
| Public-key-shaped config | present, but cannot independently verify an HMAC | public key genuinely verifies |

Sharing the code would have meant either weakening bounded-grant authenticity to the HMAC model or widening the Passport signer into something its own callers do not need. The two systems are kept separate. **Standardising by lowering this boundary to match that one would be a regression, not consistency.** Prompt 0 and Prompt 2.5's findings against the Passport signer are untouched by this prompt and remain open.

## 11. Verifier Boundary

```ts
interface AuthorityArtifactVerifier {
  verifyGrant(grant: BoundedGrant, signature: unknown): AuthoritySignatureVerification;
  verifyRevocation(revocation: GrantRevocation, signature: unknown): AuthoritySignatureVerification;
  readonly trustedKeyIds: readonly string[];   // ids only, never material
}
```

`signature` is typed `unknown` on purpose: the value comes from database columns, so it is untrusted input and the verifier is the thing that decides whether it has a usable shape at all.

### 11.1 Why verification is synchronous while signing is not

The asymmetry is deliberate and is a consequence of where each runs:

- **Verification** runs inside `runRead` — one synchronous `better-sqlite3` transaction. An `async` verifier could not be called there at all. Making the read accommodate one would mean verifying *outside* the transaction (after the read that decides) or holding a transaction open across an `await`. Both are worse than the asymmetry. Ed25519 verification is local, fast and needs no network, so nothing is given up.
- **Signing** runs before any transaction opens, so it may take as long as it takes.

### 11.2 Verification order

Fixed, and each step refuses outright rather than falling through to a weaker one:

```
envelope present?        -> AUTHORITY_SIGNATURE_MISSING
algorithm in registry?   -> AUTHORITY_SIGNATURE_ALGORITHM_UNSUPPORTED
envelope well-formed?    -> AUTHORITY_SIGNATURE_MALFORMED
artifact version known?  -> AUTHORITY_ARTIFACT_VERSION_UNSUPPORTED
key id in registry?      -> AUTHORITY_SIGNING_KEY_UNKNOWN
registry algorithm match?-> AUTHORITY_SIGNATURE_KEY_ALGORITHM_MISMATCH
decode to exact width?   -> AUTHORITY_SIGNATURE_MALFORMED
Ed25519 verify           -> AUTHORITY_SIGNATURE_INVALID | verified
```

A throw from the primitive is caught and converted to a refusal — anything the library declines to process is something this must not accept.

## 12. Trusted Verification Key Registry

An artifact says `keyId = X`. The verifier asks the **registry** what public key, if any, this deployment trusts for X. The artifact is never consulted for material.

Built once at the composition boundary, from configuration, and frozen. Refused at construction:

| Configuration | Outcome | Why |
|---|---|---|
| Duplicate key id | refused | a key id must name exactly one key; picking either would make trust depend on configuration order |
| Empty registry | refused | it would fail every read closed, which is safe but is a misconfiguration better found at startup |
| A **private** key in the verification set | refused | `createPublicKey` silently derives the public half from a private one, so this would work and never be reported — while publishing a private signing key on `PublicEnterpriseConfiguration`, a surface designed to be safe to show. Checked on the PEM text *before* parsing, because afterwards the evidence is gone |
| Key material not matching its declared algorithm | refused | a key is trusted for one algorithm |
| Unparseable material | refused, **without echoing the material** | a configuration error is not a place to log key bytes |
| Algorithm outside the closed registry | refused | |

**No remote discovery.** No JWKS, no fetch, no network lookup — asserted by a structural test over the whole module.

## 13. Key Rotation Model

```
signing key:       exactly one active key
verification keys: the active key + every historical key whose artifacts are still live
```

New artifacts are signed with the active key. Each artifact records the key id that signed it, so historical artifacts remain verifiable after rotation without re-signing anything.

### 13.1 Key-trust removal is not revocation

Removing a key from the verification set makes **every artifact it signed unreadable** — the read fails closed with `AUTHORITY_SIGNING_KEY_UNKNOWN`. This is stated explicitly because it is easy to mistake for a bulk revocation, and it is not:

| | Revocation | Key-trust removal |
|---|---|---|
| Records a decision about authority | yes | no |
| Writes a revocation record | yes | no |
| Reversible | no | yes — re-add the key |
| Affects | one grant | every artifact signed by that key |
| Read outcome | grant read, assessed unusable | grant **not readable at all** |

The rotation test asserts both directions, and asserts the revocation table is still **empty** after a key is retired — so the two can never be quietly conflated.

Retiring a key while its artifacts are live is therefore an operational decision with a blast radius, not a cleanup step. No key-expiry policy is implemented; there is no automatic retirement, and no code deletes a verification key.

## 14. Grant Signing

```
construct grant
  -> semantic validation (the 6 pre-store checks, unchanged)
  -> SIGN canonical authority bytes          [outside the transaction; may take time]
  -> BEGIN
     -> existence check      -> already-issued (verified) and stop
     -> preclusion check     -> refused GRANT_REVOKED and stop
     -> commitGuard()        -> refused and stop      [SYNCHRONOUS, no await]
     -> INSERT grant row + signature columns
     -> read back through the SAME verification path, signature included
  -> COMMIT (durable: synchronous = FULL)
  -> acknowledge
```

### 14.1 The signing/commitGuard race — analysed, not assumed away

Signing happens outside the transaction, because a `better-sqlite3` transaction is synchronous and holding one open across a signer call would make the availability of a signing service into the availability of the authority store.

That raises one question worth answering: **can eligibility change while the signer is working, so that a grant is committed under an authorization that has since been withdrawn?**

It cannot. `commitGuard` still runs **inside** the transaction, **after** the signing, immediately before the insert. The window between signing and committing is re-checked at its far end — the same discipline `ADR-OBLIGATION-DISCHARGE-AND-BOUNDED-GRANT.md` §4.6 already required, unchanged in kind and unchanged in type. The guard is still synchronous; there is still no `await` between the read that decides and the write that records. A test observes the ordering directly and asserts `sign` precedes `guard`.

A signature over a grant that is then refused is simply discarded. It never reaches storage, and a signature that was never persisted confers nothing: **authority is a committed row, not a signature someone holds.**

### 14.2 Read-back on issuance

The row is read back through the same verification path a later exercise will use, signature included. A signature over the wrong bytes, or one this deployment's own verifier does not trust, fails the issuance *then* rather than producing a grant that cannot be exercised later.

## 15. Revocation Signing

```
validate reason (closed vocabulary)  -> refused and stop, before anything is signed
  -> construct revocation (fully determined by the caller's input)
  -> SIGN                                    [outside the transaction]
  -> BEGIN
     -> grant exists?        -> refused GRANT_NOT_FOUND
     -> already revoked?     -> verified, cross-checked -> already-revoked and stop
     -> dangling pointer?    -> REFUSED (corrupt)
     -> INSERT revocation row + signature columns
     -> UPDATE grant.revocation_digest        [same transaction]
  -> COMMIT (durable)
  -> acknowledge
```

`revokedAt` is the caller's instant, never the store's clock, so signing before the transaction cannot shift it.

**Idempotency is preserved exactly.** A repeated revocation returns the **first** committed one, and does not re-sign or re-date it — asserted by comparing the stored signature, `revoked_at` and `issuer_ref` rows before and after a second call.

A grant whose own record is corrupt **can still be revoked**, unchanged from Prompt 4: recording a revocation never increases authority.

## 16. Authoritative Read Verification

Every durable authoritative read, inside one transaction:

```
row schema version         -> corrupt
canonical parse + round-trip equality  -> corrupt
identity (grant.id == row.grant_id)    -> corrupt
record envelope digest     -> corrupt
artifact's own digest      -> corrupt
SIGNATURE ENVELOPE + TRUSTED KEY + VERIFY  -> AUTHENTICITY FAILED
revocation record: schema, vocabulary, digest, SIGNATURE   -> corrupt / authenticity
grant↔revocation cross-check           -> corrupt
-> return authority state
```

Digests are checked **before** the signature, deliberately: they are cheap, they need no key, and they distinguish "the disk moved" from "no trusted key vouches for this". A writer who recomputes every digest reaches the signature check and stops there, because the one thing they cannot recompute is a signature over their new bytes.

There is **no** branch that skips verification, no legacy path, and no flag. A structural test asserts each verify call appears exactly once — one verification point per artifact type, not several to keep in step — and that every one throws on failure.

## 17. Persistence Schema

Schema version **`aoc.bounded-grant-store.schema.v2`** (was `.v1`).

Both tables gain four `NOT NULL` columns:

```sql
signature_algorithm TEXT NOT NULL,
signing_key_id      TEXT NOT NULL,
signature           TEXT NOT NULL,
signature_version   TEXT NOT NULL
```

`NOT NULL` so the **database itself** refuses to hold an unsigned authority row: "forgot to sign" becomes a write that fails rather than a row that reads as authority. A `NULL` reachable only by going around the schema is still checked, and reports `AUTHORITY_SIGNATURE_MISSING` — never "legacy, therefore trusted".

No column invites a sweeper and none is a free-form authority payload (GS-INV-012, GS-INV-017 preserved).

## 18. Legacy / Migration Behavior

**Unsigned durable records are incompatible and fail closed.** A v1 database is refused at open by the existing version guard, which runs *before* `CREATE TABLE IF NOT EXISTS` and therefore does not mutate what it refuses. A test asserts that a refused legacy database gains no signature columns.

This is the pre-production disposition the prompt prefers, and it is the right one here: the durable store shipped in Prompt 4, is opt-in (`persistence.provider === 'sqlite'`), and any database written by it contains grants issued under a store that has since changed schema version.

**Legacy records are never auto-signed.** That is the one migration that must never be automatic: signing whatever a database happens to contain, under the current key, would convert arbitrary prior content into authority this deployment cryptographically vouches for — and would erase the provenance that makes the signature mean anything. If a deployment needs to carry v1 data forward, that is explicit, operator-controlled work, and it is not implemented here.

## 19. Failure Semantics

### 19.1 Taxonomy

| Code | Meaning | Where |
|---|---|---|
| `BOUNDED_GRANT_STORE_STATE_CORRUPT` | the bytes moved | Prompt 4, unchanged |
| `BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED` | no trusted key vouches for these bytes | **new** |
| `BOUNDED_GRANT_STORE_UNAVAILABLE` | cannot open / closed / foreign schema version | Prompt 4, unchanged |
| `AuthorityAuthenticityConfigurationError` | the key boundary cannot be built | composition only |
| `AuthoritySigningUnavailableError` | the signer could not produce a signature | issue / revoke |

Corruption and authenticity are separate codes because they call for opposite operator responses: restore the data, versus find out who wrote it. Reporting a forgery attempt as a disk fault would send an operator looking in the wrong place.

Errors carry the grant id, the condition, and the failure reason. They carry **no** signature bytes, **no** signed payload and **no** key material — an error that echoed the payload would hand a caller the exact canonical bytes a forgery would have to be produced over.

### 19.2 Signer failure — the uncomfortable one

| Operation | Signer unavailable | Result |
|---|---|---|
| Issuance | throws | **no grant issued, no row written.** Correct and easy |
| Revocation | throws | **no revocation recorded, and the grant stays exercisable** |

The revocation case is stated plainly because it is a genuine availability/security tradeoff and hiding it would be worse than having it. The alternatives were:

1. Write an unsigned revocation — then the read path must accept unsigned authority state, which destroys the property this whole document establishes.
2. Report success without persisting — tells an operator authority has been withdrawn when it has not.
3. Fail loudly.

Only (3) is honest. **Signer availability is therefore now on the critical path of the emergency operation.** Recorded as **AA-004**, and an explicit input to Prompt 6: an external signing boundary makes this a *network* dependency, which is strictly worse, and is something that prompt must design for rather than discover.

## 20. Threat Model

| # | Threat | Status | Note |
|---|---|---|---|
| A | Modify grant JSON only | **BLOCKED** | digest (Prompt 4) |
| B | Modify grant + artifact digest | **BLOCKED** | envelope digest, then signature |
| C | Modify grant + every unkeyed digest | **BLOCKED** | signature. *This is the Prompt 5 delta* |
| D | Modify grant + keyId, keep signature | **BLOCKED** | verifies under the named key's material, fails |
| E | Substitute another grant's signature | **BLOCKED** | envelope binds the grant id |
| F | Put a revocation's signature on a grant | **BLOCKED** | domain separation |
| G | Remove the signature | **BLOCKED** | `NOT NULL`; `NULL` → `MISSING` |
| H | Change the algorithm field | **BLOCKED** | closed registry; must match the registry's entry for that key |
| I | Change keyId to an unknown one | **BLOCKED** | fails closed; no fallback to another trusted key |
| J | Replace the trusted public key config | **NOT ADDRESSED** | config is a trusted input; an attacker who controls it controls trust. AA-002 |
| K | Steal the private signing key | **NOT ADDRESSED** | cryptography cannot help. AA-001 → Prompt 6 |
| L | Read the private key from process memory | **NOT ADDRESSED** | it is resident there. AA-001 → Prompt 6 |
| M | DB-only write access | **BLOCKED** | the central test |
| N | DB + config write access | **NOT ADDRESSED** | equivalent to J + M |
| O | An old signing key is compromised | **PARTIALLY BLOCKED** | remove it from the verification set; artifacts it signed become unreadable (§13.1). No per-key revocation list |
| P | Rotation removes a historical verifier too early | **DEPLOYMENT-DEPENDENT** | fails closed (unreadable), never open. Documented, tested |
| Q | Artifact replay | **BLOCKED** for cross-row replay (E, F); a signature replayed onto *its own* row is a no-op |
| R | Snapshot rollback | **NOT ADDRESSED** | every artifact in an old snapshot is validly signed. **GS-002 stays open**; a signature says nothing about freshness |
| S | Signature truncation / corruption | **BLOCKED** | strict base64url + exact 64-byte width → `MALFORMED` |
| T | Duplicate key ids with conflicting keys | **BLOCKED** | refused at composition |
| U | Signer coerced to sign attacker-chosen bytes | **BLOCKED** | no generic byte-signing operation exists |
| V | Verifier accepts the wrong artifact domain | **BLOCKED** | domain separation, tested both directions |
| W | Algorithm confusion | **BLOCKED** | closed registry; no iteration, no fallback |
| X | Signing failure during issuance | **BLOCKED** | no grant, no row |
| Y | Signing failure during revocation | **PARTIALLY BLOCKED** | fails closed but withholds the revocation. AA-004, §19.2 |
| Z | Signer latency racing commitGuard | **BLOCKED** | guard runs after signing, inside the transaction, before commit. §14.1 |

## 21. Residual Risks

| ID | Severity | Risk | Owner |
|---|---|---|---|
| **AA-001** | **HIGH** | The authority signing private key is **resident in application process memory**, loaded from configuration. Anything that can read this process — a memory disclosure, a debugger, a core dump, a malicious dependency — can mint authority that verifies perfectly | **Prompt 6** |
| **AA-002** | MEDIUM | The trusted verification registry is deployment-controlled configuration. An attacker who can write it can install their own key and make their own artifacts authentic. Host/config compromise defeats this boundary | deployment; Prompt 6 narrows it |
| **AA-003** | MEDIUM | Signatures carry no freshness. A wholesale rollback to an earlier snapshot restores artifacts that are all validly signed, including grants whose revocations are rolled back with them. Same shape as **GS-002** | external anchor; unowned |
| **AA-004** | MEDIUM | Signer availability is required to **revoke**. A signer outage cannot withdraw authority and correctly refuses to pretend it did (§19.2) | Prompt 6 / Prompt 12 |
| **AA-005** | LOW | Every issuance and revocation attempt invokes the signer, including ones subsequently refused. Free today; a metered or rate-limited external signer makes it a cost | Prompt 6 |
| **AA-006** | LOW | One algorithm is registered. Adding a second is deliberate work — correct, but it means a provider that cannot do Ed25519 requires a code change, not configuration | Prompt 6 |

## 22. Findings

### New

AA-001 … AA-006 above. Each is supported by the implementation, not anticipated.

### Inherited

| ID | Was | Now |
|---|---|---|
| **GS-001** — a privileged writer can re-seal unkeyed digests | OPEN | **CLOSED for a database-only writer.** A writer with write access to the database file, and no access to a signing key, can no longer produce usable authority — proven by the central test. **Still open** for a writer who also holds the signing key or can write the key configuration (AA-001, AA-002) |
| **GS-002** — snapshot rollback can restore revoked authority | OPEN | **STILL OPEN — NOT ADDRESSED.** Signatures authenticate, they do not timestamp. Restated as AA-003 |
| **GS-003** — durable store available but not default | OPEN | unchanged; Prompt 17 |
| **GS-004** — revocation records carried no integrity | CLOSED (integrity) | now also **authenticated**, at the same strength as grants |
| **NB-009** — the store was in-memory, singly implemented, unkeyed | PARTIALLY CLOSED | *in-memory*: closed (Prompt 4). *singly implemented*: closed (Prompt 4). *unkeyed*: **closed for the durable store** by this prompt. **NOT fully closed** — the key is process-resident, so "authority the application cannot forge" is not yet true (AA-001) |
| **NB-006** — no consumption model | OPEN, unchanged | no counter, quota or decrement column added |
| **NB-008** — authority-policy integrity | OPEN, unchanged | untouched. A signature proves a trusted key vouched for a grant's bytes; it proves nothing about whether the policy that produced it was legitimate |

## 23. Security Claims

Each claim carries its scope. A restatement that drops the scope is an overclaim.

1. Bounded grants and revocations **in the durable authority store** are accepted only after cryptographic signature verification against a trusted authority verification key.
2. A database writer who can alter persisted authority and recompute every unkeyed digest **cannot forge usable authority without access to a trusted signing key**.
3. Authority verification uses **public-key material only** and is a separate interface from signing capability.
4. The bounded-grant **exercise path has no signing capability** — by type, and by structural test over its sources.
5. Grant and revocation signatures occupy **distinct cryptographic domains**; neither verifies as the other.
6. An artifact **cannot nominate its own trust root**: key ids resolve only through composition-supplied configuration.
7. There is **no unsigned mode** for the durable store — no flag, no default, no legacy path.
8. A **database written under the previous unsigned schema is refused**, not migrated and not auto-signed.
9. Prompt 4's transactional, durability and fail-closed semantics are **unchanged** — evidenced by 28 unmodified durability tests.
10. Prompt 3's no-bypass proof is **unchanged and remains PROVEN — PATH LOCAL**.

## 24. Claims We Must Not Make

| Must not say | Why |
|---|---|
| "Authority is tamper-proof" | it is not. An attacker with the signing key, the process, or the key configuration forges freely |
| "Host compromise cannot forge authority" | host compromise yields the private key (AA-001) |
| "Rollback cannot resurrect old authority" | it can. Signatures carry no freshness (AA-003 / GS-002) |
| "The signing key cannot be stolen" | it is in process memory, loaded from configuration |
| "Cryptographic authenticity proves the policy was legitimate" | it proves a trusted key vouched for these bytes. NB-008 is untouched |
| "The application process cannot access signing material" | **false today.** This becomes sayable only after Prompt 6 |
| "Frontera uses KMS/HSM" | no KMS or HSM is implemented |
| "All Frontera authority artifacts are signed" | this covers the bounded-grant path only. Agent Passport still uses HMAC (§10.4) |
| "Signatures replace the digests" | both are checked; they detect different things |
| "Key rotation revokes grants" | key-trust removal and revocation are different operations (§13.1) |

## 25. Inputs to Prompt 6

**Prompt 6 — Replace Process-Resident Signing Secrets with KMS/HSM Boundaries.**

| Question | Answer |
|---|---|
| Signing interface to preserve | `AuthorityArtifactSigner` — `activeKeyId`, `algorithm`, `signGrant`, `signRevocation`. Domain-aware; do **not** widen it to `sign(bytes)` |
| Already async? | **Yes.** Both methods return `Promise`. No call site needs restructuring for a network signer |
| Algorithm | `ed25519-v1`. Closed registry in `authority-signature.ts`. **Verify the target provider supports Ed25519** — several managed KMS products offer only ECDSA/RSA. Adding `ecdsa-p256-v1` is deliberate code + config work; there must be no negotiation or fallback |
| Key id model | opaque string; artifacts record theirs; registry resolves it. A KMS key ARN/resource name can be the key id directly |
| Current implementation | `createSoftwareAuthorityArtifactSigner` in `authority-authenticity/signer.ts` — the **only** file naming `createPrivateKey`, pinned by a structural test |
| Where the private key enters process memory | `EnterpriseConfiguration.authorityAuthenticity.signingKeyPem`, from `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`, parsed once in the signer |
| How many processes hold it | every process that composes the **durable** store. In-memory-store deployments hold none |
| Verification registry | stays local and public-key-only. A KMS adapter replaces the **signer**; the verifier should keep verifying locally, so a KMS outage does not stop reads |
| Signing call sites | exactly two: `issue` and `revoke` in `sqlite-bounded-grant-store.ts`, both **outside** the transaction, both via `signGrantOrFail` |
| Latency assumptions | signing is on the issuance and revocation paths, not the read path. Every issuance and revocation attempt signs, refused ones included (AA-005) — consider a pre-check if the provider meters calls |
| Error semantics to preserve | `AuthoritySigningUnavailableError` must stay a **hard failure**. No unsigned fallback, no "signed later", no optimistic acknowledgement |
| commitGuard race | already handled: sign → BEGIN → commitGuard → INSERT → COMMIT. **Preserve this order.** A KMS call inside the transaction would be a correctness and availability regression |
| Rotation | registry holds active + historical. A KMS adapter must keep recording the *signing* key id on each artifact |
| **The target invariant** | **No production authority-signing private key is resident in application process memory.** Today: FALSE. `SEC-INV-U02` stays NOT IMPLEMENTED until it is true |

---

## Change Control

1. A new `AuthorityArtifactSigner` or `AuthorityArtifactVerifier` implementation must be added to §10/§11 before it ships and must satisfy every AA-INV in §5.
2. An AA-INV may only be strengthened by evidence. Editing the prose is not promotion.
3. §23's claims travel with their scope. A restatement omitting "in the durable authority store" or "without access to a trusted signing key" is an overclaim.
4. §24 is not advisory. Adding a §23 claim that contradicts a §24 row requires deleting that row, and deleting it requires the evidence that makes it false.
5. Findings close on evidence, not documentation. AA-001 closes when the signing key is provably outside the process, not when this file is edited.
6. Any new algorithm entry must be justified against AA-INV-008 and AA-INV-018, and must not introduce negotiation, fallback, or try-until-one-verifies.
7. No unsigned or verification-optional mode may be added to the durable store. If backwards compatibility ever appears to require one, that is a design review, not a patch.
