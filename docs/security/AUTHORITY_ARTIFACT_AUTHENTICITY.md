# Authority Artifact Authenticity

- **Track:** Security & Containment Architecture. Authored as the historical security-track **Prompt 5** (commit `03c1eb2`) and forward-ported onto current main as **PRE-00**.
- **Numbering:** "Prompt N" in this document is the legacy security-hardening prompt series — the same labels `SECURITY_INVARIANTS.md` and `AUTHORITATIVE_GRANT_STORE.md` use — kept as provenance, not as the active roadmap. Sections written before CORE-02 describe external key custody as *deferred*; that work is delivered by **CORE-02** (§29).
- **Scope:** the authority artifacts the governed path trusts — `BoundedGrant`, `GrantRevocation`, the grant store's signed **revocation-state commitment** (CORE-01), the obligation discharge store's signed state (CORE-04, §27) and the approval store's signed state (CORE-05, §28) — five artifacts, five structured signing operations, one key role.
- **Status:** implemented for the durable stores. Key custody is a configuration choice since **CORE-02** (§29): **external** — no authority private key in the Frontera process (AA-001 closed *for this mode*) — or **software** — the key is process-resident (AA-001 remains for this mode). Revocation-state integrity (removal of a revocation by a database-only writer) closed by **CORE-01** — §26.
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

Since CORE-01 both artifacts are also signed **as filed in one store**: the record envelope carries the store's `storeId` (§26.3).

### 4.2a Revocation-state commitment (CORE-01)

| Field | Authority-relevant | Covered |
|---|---|---|
| `storeId` | which store's revocation set this is | yes |
| `sequence` | how many revocations the store has ever committed | yes |
| `revocationSetDigest` | every committed revocation, in order (sequence, grant id, record digest) | yes |

One row per store. See §26.

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
| **AA-INV-022** | A signer failure never becomes an unsigned write | `signOrFail` has no branch that returns without a signature | signer-down issue/revoke/genesis tests |
| **AA-INV-023** (CORE-01) | "Not revoked" is a signed statement, never the absence of a row | `currentRevocation` answers from the verified commitment; every authoritative transaction runs `verifiedRevocationState()` first | `revocation-state-integrity.test.ts` C, E, E+K; structural: every transaction proves the state before reading a row |
| **AA-INV-024** (CORE-01) | The revocation set actually present must be exactly the set the signed commitment describes — same count, contiguous sequence, same digest | `verifiedRevocationState` | C, E, G, H, renumbering test |
| **AA-INV-025** (CORE-01) | Grant, revocation and commitment are bound to one store; no genuine artifact of another store verifies here | `storeId` in every record envelope and in the commitment | E+ (foreign genesis splice) |
| **AA-INV-026** (CORE-01) | Nothing is ever signed over a revocation state that has not just verified — tampering cannot be laundered into a new signature | revocation plans and re-attestation build only from `verifiedRevocationState()` | no-laundering, re-attestation-never-signs-tampered tests |
| **AA-INV-027** (CORE-01) | A durable deployment never silently runs on an unauthenticated grant store | runtime brand checked at composition; `EXECUTION_GRANT_STORE_NOT_AUTHENTICATED` | O tests (in-memory, shape-alike, wrapper refused) |

| **AA-INV-028** (CORE-02) | Under external custody no authority private key enters the Frontera process: no configuration field, no environment variable, no parsing | external variant has no key field; key variable refused; external composition returns before any private-key code | configuration, structure, canonical-Host and launcher (`/proc/<pid>/environ`) tests |
| **AA-INV-029** (CORE-02) | The external signer's identity is pinned to the trusted registry — key id, algorithm and public key — and proven before any store opens; remote material never becomes trust | `establishExternalAuthorityArtifactSigner` | handshake matrix, endpoint/registry substitution, no-TOFU tests |
| **AA-INV-030** (CORE-02) | No signature reaches a store unless it verifies locally, over the exact artifact, under the pinned key | adapter `accept()` + store read-back | malicious-signer and cross-domain matrices |
| **AA-INV-031** (CORE-02) | There is no fallback between custodies and no mixed custody | no fallback code; custody brand on signer and stores; Host posture check | fallback, mixed-custody and structure tests |
| **AA-INV-032** (CORE-02) | Every external signer call is time-bounded, and only availability failures are retried, within a fixed bound | adapter + transport | timeout and retry-class tests |
| **AA-INV-033** (CORE-02) | Signer availability never gates verification: every read verifies locally with the signer down | verifier independent of signer | real-outage store and canonical-Host tests |
| **AA-INV-034** (CORE-02) | The custody protocol is structured: one operation per artifact kind, no generic byte signing, no key export | protocol, transport port, reference service | structure tests, reference-service route tests |
| **AA-INV-035** (CORE-02R) | Under external custody every authority store is built by the composition root over the configured, proven boundary; no supplied store is adopted | composition refusal before anything opens | review-hardening A1 … A6 |
| **AA-INV-036** (CORE-02R) | A signing failure is cleared only by a successful, locally verified signature — never by an identity probe | separate `identity` / `lastSigning` monitor states | review-hardening B; structure rule |
| **AA-INV-037** (CORE-02R) | The startup identity handshake honours `maxAttempts` for availability failures and never retries an answer | shared `withBoundedAttempts` | review-hardening C1 … C7 |
| **AA-INV-038** (CORE-02R) | The canonical external Host refuses the authority-key variable in its real process environment | `bootEnterpriseHost` pre-composition check | process-env suite |

AA-INV-021 and AA-INV-022 are additions beyond the prompt's list, both required by what the source actually does. AA-INV-023 … AA-INV-027 are CORE-01's. AA-INV-028 … AA-INV-034 are CORE-02's; AA-INV-035 … AA-INV-038 are its post-merge review hardening (CORE-02R, §29.11).

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

**Honest note for the deferred external key-custody work:** Ed25519 support is not universal across managed KMS providers — some offer only ECDSA (P-256/384/521) and RSA for asymmetric signing. The algorithm registry (§30 of the historical prompt; `SUPPORTED_AUTHORITY_SIGNATURE_ALGORITHMS` in source) is closed and versioned precisely so a second entry can be added as deliberate code-and-configuration work if the chosen provider requires it. Adding one is not automatic and there is no negotiation, no fallback and no try-until-one-verifies.

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
grant:            "frontera:authority-artifact:bounded-grant:v1\n"    + serializeStoredGrantRecord(grant, storeId)
revocation:       "frontera:authority-artifact:grant-revocation:v1\n" + serializeStoredRevocationRecord(revocation, storeId)
revocation state: "frontera:authority-artifact:revocation-state:v1\n" + serializeRevocationStateCommitment(state)     (CORE-01)
obligation discharge state: "frontera:authority-artifact:obligation-discharge-state:v1\n" + serializeObligationDischargeStateCommitment(state)     (CORE-04)
approval state:   "frontera:authority-artifact:approval-state:v1\n"   + serializeApprovalStateCommitment(state)       (CORE-05)
```

Custody does not change these bytes (CORE-02): a software and an external signer holding the same key produce identical signatures (§29.9).

There is exactly **one** function producing each — signing and verification call the same one, so the two sides cannot drift.

**Forward-port note (PRE-00).** Since this mechanism was first written, current main added two things to a grant's canonical form: the optional `authorityBindingDigest` provenance field (P7) and exact decimal-string monetary ceilings (P9). Both are emitted by `serializeBoundedGrant`, which `serializeStoredGrantRecord` embeds, so both are inside the signed bytes with no change to the signing format. A test mutates each and asserts the signature no longer verifies. The canonical format and both domain prefixes are unchanged from the historical implementation.

### 8.2 Why the record envelope rather than the artifact alone

`serializeStoredGrantRecord` binds five things in one deterministic string (record format v2 / schema v3 since CORE-01, which added `storeId`):

```
{"format":"aoc.bounded-grant-store.record.v2","grant":<canonical grant>,"grantId":"<id>","kind":"grant","schemaVersion":"aoc.bounded-grant-store.schema.v3","storeId":"<store id>"}
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
2. The payload's own `"kind":"grant"` / `"kind":"revocation"` / `"kind":"revocation-state"` field.

The prompt's rule — *do not rely only on JSON shape* — is why (1) exists. The deliberate-violation experiment is the evidence it is doing work: collapsing both domains to one string left the cross-artifact confusion tests **passing**, because the payload JSON still differed, and was caught only by the test that asserts the two domain constants differ. Shape alone would have been an accidental property, dependent on two serializers continuing to disagree. The prefix makes separation a property of the signing input itself.

## 10. Signer Boundary

### 10.1 Interface

```ts
interface AuthorityArtifactSigner {
  readonly activeKeyId: string;
  readonly algorithm: AuthoritySignatureAlgorithm;
  signGrant(grant: BoundedGrant, storeId: string): Promise<AuthoritySignature>;
  signRevocation(revocation: GrantRevocation, storeId: string): Promise<AuthoritySignature>;
  signRevocationState(state: RevocationStateCommitment): Promise<AuthoritySignature>;                   // CORE-01
  signObligationDischargeState(state: ObligationDischargeStateCommitment): Promise<AuthoritySignature>; // CORE-04
  signApprovalState(state: ApprovalStateCommitment): Promise<AuthoritySignature>;                       // CORE-05
}
```

Five operations, all structured. Two implementations exist: the **software** signer (§10.3) and, since CORE-02, the **external** signer (§29), which implements exactly these five methods over a custody boundary outside the process.

**Domain-aware, never generic.** There is no `sign(bytes)`. A generic byte-signing capability would let any holder produce a signature over bytes of its own choosing — for a key whose meaning is "this artifact is authoritative", that is the ability to mint authority in a shape the signer has never seen. Least authority applies to a crypto API exactly as it applies to a store port. A structural test asserts the interface exposes no raw signing operation.

### 10.2 Why `async`

Nothing about in-process Ed25519 needs to be asynchronous. The interface is `Promise`-returning so that (a) external key custody (CORE-02, §29) substitutes a call across a custody boundary without changing a call site — which is what happened: no store call site changed — and (b) — more importantly — every caller is *already written* to tolerate a signer that takes time. §14.1 explains why that makes the commit ordering safe rather than merely convenient.

### 10.3 The implementation, named honestly

`createSoftwareAuthorityArtifactSigner` holds a **private key in application process memory**, loaded from configuration. It is not a hardware boundary, not a KMS, not an HSM. Recorded as **AA-001**. Since CORE-02 it is one of two explicit custodies (`software`); a deployment configured for `external` custody never constructs it and never falls back to it (§29). The key is parsed once into a `KeyObject` held in a closure: never returned, never placed on the object, never serialized into a record, never logged, and never included in an error message — the parse failure paths discard the underlying error precisely because it can quote the material it failed to parse.

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

**CORE-02 decision (TD-5).** The authority key is not extended to passports: `AuthorityArtifactSigner` gains no passport operation (structurally tested), because that would widen what the authority key vouches for. The Enterprise Host composes no passport signer; the HMAC `createTestSigner` is used only by the standalone `apps/agent-passport-web` issuer. A publicly verifiable passport needs its own asymmetric key role — owned by **CTRL-02**, which may reuse the CORE-02 custody pattern and transport. Until then, passports are not publicly verifiable (§24).

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

As of CORE-01 (the pre-CORE-01 flow signed one artifact and had no commitment):

```
validate reason (closed vocabulary)  -> refused and stop, before anything is signed
  -> construct revocation (fully determined by the caller's input)
  -> [in-process revocations are serialized]
  -> PLAN (read transaction)
     -> VERIFY REVOCATION STATE (commitment signature, count, sequence, digest)   -> refuse on any failure
     -> grant exists?        -> refused GRANT_NOT_FOUND           (nothing signed)
     -> already revoked?     -> verified, cross-checked -> already-revoked and stop   (nothing signed)
     -> next commitment = verified set + this revocation, sequence + 1
  -> SIGN revocation, SIGN next commitment      [outside the transaction]
  -> BEGIN IMMEDIATE
     -> VERIFY REVOCATION STATE again; changed since the plan?  -> STALE, re-plan (bounded)
     -> INSERT revocation row (with its sequence) + signature columns
     -> UPDATE grant.revocation_digest
     -> UPDATE commitment (sequence + 1, new digest, new signature)
     -> read back: VERIFY REVOCATION STATE + this revocation
  -> COMMIT (durable)
  -> acknowledge
```

`revokedAt` is the caller's instant, never the store's clock, so signing before the transaction cannot shift it.

**Idempotency is preserved exactly.** A repeated revocation returns the **first** committed one, and does not re-sign or re-date it — asserted by comparing the stored signature, `revoked_at` and `issuer_ref` rows before and after a second call.

A grant whose own record is corrupt **can still be revoked**, unchanged from Prompt 4: recording a revocation never increases authority.

## 16. Authoritative Read Verification

Every durable authoritative read, inside one transaction:

```
REVOCATION-STATE COMMITMENT (CORE-01), before any row is read:
  present?                 -> REVOCATION_STATE_INCONSISTENT
  schema, store id, sequence well formed -> REVOCATION_STATE_INCONSISTENT
  signature, trusted key   -> AUTHENTICITY FAILED
  rows == sequence, contiguous 1..n, set digest matches -> REVOCATION_STATE_INCONSISTENT
  not older than the newest this process verified      -> REVOCATION_STATE_INCONSISTENT
row schema version         -> corrupt
canonical parse + round-trip equality  -> corrupt
identity (grant.id == row.grant_id)    -> corrupt
record envelope digest     -> corrupt
artifact's own digest      -> corrupt
SIGNATURE ENVELOPE + TRUSTED KEY + VERIFY  -> AUTHENTICITY FAILED
revocation (from the COMMITMENT, not from row presence): schema, vocabulary, digest, SIGNATURE, matches committed entry -> corrupt / authenticity / inconsistent
grant↔revocation pointer cross-check   -> corrupt   (defense in depth only; no longer the evidence)
-> return authority state
```

Digests are checked **before** the signature, deliberately: they are cheap, they need no key, and they distinguish "the disk moved" from "no trusted key vouches for this". A writer who recomputes every digest reaches the signature check and stops there, because the one thing they cannot recompute is a signature over their new bytes.

There is **no** branch that skips verification, no legacy path, and no flag. A structural test asserts each verify call appears exactly once — one verification point per artifact type, not several to keep in step — and that every one throws on failure.

## 17. Persistence Schema

Schema version **`aoc.bounded-grant-store.schema.v3`** since CORE-01 (§26.5). The text below describes the v2 change that introduced signing, which v3 keeps.

Schema version **`aoc.bounded-grant-store.schema.v2`** (was `.v1`).

The bump is still the correct next version on current main: between the historical branch point and the forward-port, main never changed the bounded-grant store's schema version — P7's `authorityBindingDigest` lives inside `grant_json` and needed no column. Nothing newer was downgraded or replaced.

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

**CORE-01 (v2 → v3).** A v2 database is refused at open in exactly the same way, and for a stronger reason: its rows are bound to no store id and it holds no revocation-state commitment, so the completeness of its revocation set cannot be proven. Minting a commitment for it would sign whatever set of revocations the file currently contains — including one that has already been pruned. No commitment is ever created for a file that already holds authority tables (tested).

**Operational consequence.** A deployment that already runs the durable store (`persistence.provider === 'sqlite'`) will find its existing `bounded-grants.sqlite` refused at open after upgrading, with `BOUNDED_GRANT_STORE_UNAVAILABLE`. That is intended. The operator must decide what happens to the authority it holds — typically re-issue through the normal issuance path under the new key, into a fresh file — and must not "fix" it by signing the old rows. Nothing in this repository modifies an existing database to make it open.

## 19. Failure Semantics

### 19.1 Taxonomy

| Code | Meaning | Where |
|---|---|---|
| `BOUNDED_GRANT_STORE_STATE_CORRUPT` | the bytes moved | Prompt 4, unchanged |
| `BOUNDED_GRANT_STORE_AUTHENTICITY_FAILED` | no trusted key vouches for these bytes (a record, or the revocation-state commitment) | **new** |
| `BOUNDED_GRANT_STORE_REVOCATION_STATE_INCONSISTENT` | the revocation set cannot be proven complete: commitment absent, rows disagree with it, sequence gap, or a regression this process observed | **CORE-01** |
| `EXECUTION_GRANT_STORE_NOT_AUTHENTICATED` | a durable Host was handed a grant store that is not the authenticated durable store | **CORE-01**, composition only |
| `BOUNDED_GRANT_STORE_UNAVAILABLE` | cannot open / closed / foreign schema version | Prompt 4, unchanged |
| `AuthorityAuthenticityConfigurationError` | the key boundary cannot be built | composition only |
| `AuthoritySigningUnavailableError` | the signer could not produce a signature. Since CORE-02 it carries a closed `reason` (`EXTERNAL_SIGNER_*`, §29.6) when the signer is external | issue / revoke / append / genesis |
| `AuthorityAuthenticityConfigurationError` with `reason` | CORE-02: the external signer's identity could not be proven at startup (unreachable, credential refused, identity mismatch, capability unsupported, malformed) | composition only |
| HTTP `503 AUTHORITY_SIGNER_UNAVAILABLE` (`recorded: false`) | CORE-02: the admin revocation could not be signed; nothing was recorded and the grant remains exercisable | admin API |

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

Only (3) is honest. **Signer availability is therefore now on the critical path of the emergency operation.** Recorded as **AA-004**, and an explicit input to the deferred external key-custody work: an external signing boundary makes this a *network* dependency, which is strictly worse, and is something that prompt must design for rather than discover.

**CORE-02 update.** Designed for, not discovered (§29.7): every signer call is time-bounded and retried only for availability failures, within a fixed attempt bound; an outage writes nothing for issuance, revocation, discharge, approval or genesis; the admin revocation answers `503 AUTHORITY_SIGNER_UNAVAILABLE` with `recorded: false` and says the grant remains exercisable; `/health` reports the signer `unavailable` and the Host `degraded`; reads and exercise of existing authority continue on local verification; and the durable **emergency stop**, which does not depend on the signer, still withholds exercise (it is not a revocation). AA-004 remains **open** — revocation still needs the signer; there are no redundant signers and no signer-independent revocation path.

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
| K | Steal the private signing key | **External custody: moved out of the process** (CORE-02); software custody: NOT ADDRESSED | external: the key is in the custody service, never in Frontera; a compromise of the custody service itself is out of scope. Software: AA-001 |
| L | Read the private key from process memory | **BLOCKED for external custody** (CORE-02); **NOT ADDRESSED for software custody** | external: no private key is in the Host process — configuration, environment or memory (§29.4); software: resident (AA-001) |
| L2 | A compromised Host asks the external signer to sign | **NOT ADDRESSED** (CORE-02 residual) | the Host's service credential authorizes signing requests; external custody prevents key extraction, not use while compromised (AA-010, §29.10) |
| L3 | A substituted or re-keyed external signer | **BLOCKED** (CORE-02) | identity pinned to the trusted registry at startup (key id, algorithm, public key); every returned signature verified locally under the pinned key before persistence; mid-process key change refused |
| L4 | A malicious signer returns a wrong-key, cross-domain, other-artifact or malformed signature | **BLOCKED** (CORE-02) | local pre-commit verification + store read-back; nothing is persisted |
| L5 | Silent fallback from external to in-process signing | **BLOCKED** (CORE-02) | no fallback exists; a private key alongside external custody refuses the Host |
| M | DB-only write access | **BLOCKED** (since CORE-01) — including removal of a revocation | the central test; §26. A *restore of a previously captured, genuinely signed state* is threat R, not M |
| N | DB + config write access | **NOT ADDRESSED** | equivalent to J + M |
| O | An old signing key is compromised | **PARTIALLY BLOCKED** | remove it from the verification set; artifacts it signed become unreadable (§13.1). No per-key revocation list |
| P | Rotation removes a historical verifier too early | **DEPLOYMENT-DEPENDENT** | fails closed (unreadable), never open. Documented, tested |
| Q | Artifact replay | **BLOCKED** for cross-row replay (E, F); a signature replayed onto *its own* row is a no-op |
| R | Snapshot rollback | **PARTIALLY BLOCKED** (CORE-01) | detected **while the process runs** (in-process freshness witness, §26.6); **not detected across a restart**. **GS-002 stays open** → CORE-07 |
| R2 | Delete a revocation row and clear the grant's pointer (the MASTER-00 un-revocation) | **BLOCKED** (CORE-01) | the signed commitment no longer describes the rows; `REVOCATION_STATE_INCONSISTENT`. Test E |
| R3 | R2 + rewrite the commitment's unkeyed fields | **BLOCKED** (CORE-01) | commitment signature. Test E+K |
| R4 | R2 + splice in a genuine commitment from another store under the same key (e.g. the genesis of a re-created file) | **BLOCKED** (CORE-01) | store binding: this store's grants are signed for this store's id. Test E+ |
| R5 | Host injects an unauthenticated grant store into a durable deployment | **BLOCKED** (CORE-01) for composition mistakes | runtime brand; a malicious in-process host is out of scope (§26.8) |
| S | Signature truncation / corruption | **BLOCKED** | strict base64url + exact 64-byte width → `MALFORMED` |
| T | Duplicate key ids with conflicting keys | **BLOCKED** | refused at composition |
| U | Signer coerced to sign attacker-chosen bytes | **BLOCKED** | no generic byte-signing operation exists |
| V | Verifier accepts the wrong artifact domain | **BLOCKED** | domain separation, tested both directions |
| W | Algorithm confusion | **BLOCKED** | closed registry; no iteration, no fallback |
| X | Signing failure during issuance | **BLOCKED** | no grant, no row |
| Y | Signing failure during revocation | **PARTIALLY BLOCKED** | fails closed but withholds the revocation; since CORE-02 bounded, observable, reported as not recorded, mitigated by emergency stop. AA-004, §19.2, §29.7 |
| Z | Signer latency racing commitGuard | **BLOCKED** | guard runs after signing, inside the transaction, before commit. §14.1 |

> **MASTER-00 correction (2026-09-25), resolved by CORE-01.** MASTER-00 found threat M was not fully
> blocked: the grant row's `revocation_digest` pointer was not covered by any signature, so a
> database-only writer who deleted the `bounded_grant_revocations` row **and** set
> `bounded_grants.revocation_digest = NULL` made a revoked grant read as live. CORE-01 reproduced it
> (the grant was *executed*, adapter called once) and closed it with the signed revocation-state
> commitment (§26). The pointer remains only as a cross-check that can cause a refusal.

## 21. Residual Risks

| ID | Severity | Risk | Owner |
|---|---|---|---|
| **AA-001** | **HIGH** (software custody) · **CLOSED for external custody** (CORE-02) | Under **software** custody the authority signing private key is **resident in application process memory**, loaded from configuration; anything that can read this process can mint authority that verifies perfectly. Under **external** custody no authority private key is in the Frontera process (proven by the canonical-Host and launcher E2E, §29.4). What external custody does **not** remove — a compromised Host asking the signer to sign while it holds the credential — is recorded separately as AA-010 | CORE-02 (external mode); software mode remains by choice |
| **AA-002** | MEDIUM | The trusted verification registry is deployment-controlled configuration. An attacker who can write it can install their own key and make their own artifacts authentic. **Narrowed by CORE-02:** the external signer's identity is proven against the registry at startup (key id, algorithm, public key), so substituting or miswiring *either* half alone is refused. An attacker who can rewrite the signer endpoint **and** the registry **and** the Host configuration still controls trust — there is no independent configuration trust root | deployment; independent configuration trust root unassigned |
| **AA-003** | MEDIUM | Signatures carry no freshness. A wholesale rollback to an earlier snapshot — or a restore of a previously *captured* commitment together with the rows it covered — restores artifacts that are all validly signed, including grants whose revocations are rolled back with them. Since CORE-01 this requires a copy of the earlier signed state (removing rows no longer suffices), and a running process detects it; a restarted one does not. Old commitment bytes can also persist in WAL frames or free pages of the file. Same shape as **GS-002** | **CORE-07** |
| **AA-004** | MEDIUM | Signer availability is required to **revoke**. A signer outage cannot withdraw authority and correctly refuses to pretend it did (§19.2). **CORE-02:** designed and observable — bounded time and attempts, `503 AUTHORITY_SIGNER_UNAVAILABLE` / `recorded: false`, `/health` degraded, nothing written, emergency stop independent of the signer (§29.7). Still **open**: no redundant signers, no quorum, no signer-independent revocation | OPEN — future (redundant custody / signer-independent revocation), unassigned |
| **AA-005** | LOW | Every signer call may be metered or rate-limited. **CORE-02:** issuance preflight settles already-issued, precluded and already-ineligible grants before signing; revocation already settled unknown and already-revoked grants before signing; health probes never sign; expected call counts are documented and tested (§29.8). Unavoidable waste remains: a signature for an issuance whose eligibility changes in flight, a stale revocation plan, a retried lost response | partially addressed; provider pricing/limits are deployment-dependent |
| **AA-006** | LOW | One algorithm (`ed25519-v1`). **CORE-02:** the deployment pins and proves its signer's algorithm exactly (no negotiation); a provider must support Ed25519 or sit behind a custody server that does. Adding a second algorithm remains deliberate cryptographic work | portability constraint, unchanged |
| **AA-007** (CORE-01) | LOW | A database-only writer who tampers with the revocation state makes **every** read refuse — a denial of service against the store. This is the intended fail-closed direction; recovery is a restore from a trusted copy, never an automatic repair | deployment (PROD-02 backup/restore) |
| **AA-008** (CORE-01) | LOW | Every authoritative read recomputes the revocation-set digest over all committed revocations: O(number of revocations). Revocations are rare relative to grants; a very large revocation history would need an authenticated index (e.g. a Merkle structure) | future, if measured |
| **AA-009** (CORE-01) | LOW | Revocation now needs **two** signatures (revocation + commitment) and opening a **new** store needs one (genesis). AA-004 and AA-005 therefore apply to both | CORE-02: both are external under external custody, time-bounded, and a failed genesis leaves no initialized file (§29) |
| **AA-010** (CORE-02) | MEDIUM | Under external custody the Host holds a **service credential** that authorizes structured signing requests. A fully compromised Host can use it to obtain signatures over artifacts of its choosing while it is compromised; it cannot extract the key, and rotating the credential ends its use. The reference custody service enforces no independent policy. The credential is a secret (never logged, echoed or published) but is not the key | future: independent service-side authorization; deployment credential hygiene |
| **AA-011** (CORE-02) | LOW | A Host restarted while its external signer is unreachable does not start (its signer identity cannot be proven), so reads are unavailable until the signer answers. Deliberate (§29.7); a degraded read-only boot is not offered | deployment (signer availability) |

## 22. Findings

### New

AA-001 … AA-006 above. Each is supported by the implementation, not anticipated.

### Inherited

| ID | Was | Now |
|---|---|---|
| **GS-001** — a privileged writer can re-seal unkeyed digests | OPEN | **CLOSED for a database-only writer (CORE-01 closed the un-revocation gap MASTER-00 found).** A writer with write access to the database file, and no access to a signing key, can neither produce usable authority nor remove a committed revocation — proven by the central test and `revocation-state-integrity.test.ts`. **Still open** for a writer who also holds the signing key or can write the key configuration (AA-001, AA-002), and for restore of a previously captured signed state (GS-002 / AA-003) |
| **GS-002** — snapshot rollback can restore revoked authority | OPEN | **STILL OPEN.** Narrowed by CORE-01: needs a *captured* earlier signed state rather than row deletion, and is detected while the process runs; not detected across a restart. Restated as AA-003 → CORE-07 |
| **GS-003** — durable store available but not default | OPEN | **CLOSED for the shipped Host by PROD-01**: the secure profile refuses anything but `sqlite`, and a secure Host refuses to bind unless its grant store is `authenticated-durable` (SEC-INV-126). The embedding default (`createEnterprise`) is still `memory` |
| **GS-004** — revocation records carried no integrity | CLOSED (integrity) | now also **authenticated**, at the same strength as grants |
| **NB-009** — the store was in-memory, singly implemented, unkeyed | PARTIALLY CLOSED | *in-memory*: closed (Prompt 4). *singly implemented*: closed (Prompt 4). *unkeyed*: **closed for the durable store** by this prompt. *Process-resident key*: closed **for external custody** by CORE-02. **Still not** "authority the application cannot forge": a compromised Host can ask the external signer to sign (AA-010), and software custody keeps the key in process (AA-001) |
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
11. (CORE-01) **In the durable authority store**, a database writer **without access to a trusted signing key** cannot make a committed revocation disappear: deleting, clearing, rewriting, moving or renumbering revocation state, or splicing in another store's genuine commitment, makes authoritative reads fail closed, and the governed execution path withholds.
12. (CORE-01) A Host configured for durable persistence **refuses** a host-supplied grant store that is not the authenticated durable store.

## 24. Claims We Must Not Make

| Must not say | Why |
|---|---|
| "Authority is tamper-proof" | it is not. An attacker with the signing key, the process, or the key configuration forges freely |
| "Host compromise cannot forge authority" | software custody: host compromise yields the private key (AA-001). External custody: it does not yield the key, but a compromised Host can still *ask* the custody service to sign while it holds the credential (AA-010) |
| "Rollback cannot resurrect old authority" | it can. Signatures carry no freshness (AA-003 / GS-002). CORE-01 detects it only within a running process |
| "Database compromise cannot un-revoke a grant" | only a database-only writer *without a captured earlier signed state* is blocked. A restore of such a state across a restart is not detected (CORE-07) |
| "A malicious host cannot bypass the signed store" | the composition check guards mistakes. Code in the same process can replace the check (§26.8) |
| "The signing key cannot be stolen" | under software custody it is in process memory; under external custody it is in the custody service, whose own compromise is out of scope — and the reference service is a plain file-backed key |
| "Cryptographic authenticity proves the policy was legitimate" | it proves a trusted key vouched for these bytes. NB-008 is untouched |
| "The application process cannot access signing material" | sayable **only** with the scope "under external custody, the Frontera process holds no authority private key" (CORE-02). False for software custody, and never means the process cannot *request* signatures (AA-010) |
| "Frontera uses KMS/HSM" / "HSM-protected authority keys" | no KMS or HSM integration ships. CORE-02 ships a vendor-neutral external-signer boundary and a **reference** custody service that is neither hardware-backed nor an HSM |
| "Revocation works during a signer outage" | it does not: it fails honestly (AA-004). An emergency stop withholds exercise without the signer; it is not a revocation |
| "All Frontera authority artifacts are signed" | this covers the bounded-grant path only. Agent Passport still uses HMAC (§10.4) |
| "Signatures replace the digests" | both are checked; they detect different things |
| "Key rotation revokes grants" | key-trust removal and revocation are different operations (§13.1) |

## 25. Inputs to external key custody (historical — delivered by CORE-02, §29)

**Historical work item — replace process-resident signing secrets with KMS/HSM boundaries** (legacy label: security Prompt 6), owned and delivered by **CORE-02** (§29). The table records the constraints CORE-02 inherited; where a row says "today", read it as "before CORE-02".

| Question | Answer |
|---|---|
| Signing interface to preserve | `AuthorityArtifactSigner` — `activeKeyId`, `algorithm`, `signGrant(grant, storeId)`, `signRevocation(revocation, storeId)`, `signRevocationState(state)` (CORE-01), `signObligationDischargeState(state)` (CORE-04), `signApprovalState(state)` (CORE-05). Domain-aware; do **not** widen it to `sign(bytes)`. The complete operation set an external signer (CORE-02) must implement is these five |
| Already async? | **Yes.** All five methods return `Promise`. No call site needed restructuring for a network signer (confirmed by CORE-02) |
| Algorithm | `ed25519-v1`. Closed registry in `authority-signature.ts`. **Verify the target provider supports Ed25519** — several managed KMS products offer only ECDSA/RSA. Adding `ecdsa-p256-v1` is deliberate code + config work; there must be no negotiation or fallback |
| Key id model | opaque string; artifacts record theirs; registry resolves it. A KMS key ARN/resource name can be the key id directly |
| Current implementation | `createSoftwareAuthorityArtifactSigner` in `authority-authenticity/signer.ts` — the **only** file naming `createPrivateKey`, pinned by a structural test |
| Where the private key enters process memory | `EnterpriseConfiguration.authorityAuthenticity.signingKeyPem`, from `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM`, parsed once in the signer |
| How many processes hold it | every process that composes the **durable** store. In-memory-store deployments hold none |
| Verification registry | stays local and public-key-only. A KMS adapter replaces the **signer**; the verifier should keep verifying locally, so a KMS outage does not stop reads |
| Signing call sites | in `sqlite-bounded-grant-store.ts`, all **outside** any transaction, all via `signOrFail` except re-attestation: `issue` (grant), `revoke` (revocation + commitment), open of a new store (genesis commitment), open of an existing store whose commitment is signed by a non-active trusted key (best-effort re-attestation, §26.7) |
| Latency assumptions | signing is on the issuance and revocation paths, not the read path. Every issuance and revocation attempt signs, refused ones included (AA-005) — consider a pre-check if the provider meters calls |
| Error semantics to preserve | `AuthoritySigningUnavailableError` must stay a **hard failure**. No unsigned fallback, no "signed later", no optimistic acknowledgement |
| commitGuard race | already handled: sign → BEGIN → commitGuard → INSERT → COMMIT. **Preserve this order.** A KMS call inside the transaction would be a correctness and availability regression |
| Rotation | registry holds active + historical. A KMS adapter must keep recording the *signing* key id on each artifact |
| **The target invariant** | **No production authority-signing private key is resident in application process memory.** CORE-02: TRUE under external custody (SEC-INV-147); software custody remains an explicit, supported mode where it is false. `SEC-INV-U02` is now PARTIALLY IMPLEMENTED |

## 26. CORE-01 — Revocation-State Integrity

### 26.1 The defect

A signed revocation proves a revocation is genuine. It proves nothing about whether a genuine revocation has been **removed**. Before CORE-01, the only statement "this grant has a revocation" was the unsigned `bounded_grants.revocation_digest` pointer. Deleting the revocation row and nulling the pointer returned the grant row to exactly the bytes it held before revocation — genuinely signed, internally consistent — and nothing unkeyed needed recomputing. Reproduced on `main @ a0a0e3b` before the fix: the grant read back live and `createGrantExecutionService.exercise` returned `executed` with the adapter called once.

### 26.2 The model

The store holds one **revocation-state commitment**: `{storeId, sequence, revocationSetDigest}`, where `revocationSetDigest` is SHA-256 over `[[sequence, grantId, revocationRecordDigest], …]` in sequence order, and the commitment is Ed25519-signed under its own domain (`frontera:authority-artifact:revocation-state:v1`). Each revocation row carries its `sequence` (1, 2, 3 … with no gaps).

- **Read.** Every authoritative transaction verifies the commitment (present, well formed, signed by a trusted key), then checks that the revocation rows present are *exactly* the ones it describes, before any grant is answered for. "Not revoked" is returned only when the signed commitment lists no revocation for the grant. The revocation row for a listed grant must then pass its own digest and signature checks and match the committed entry.
- **Write.** A revocation plans against the verified state, signs the revocation and the successor commitment outside the transaction, and commits row + pointer + commitment in one `BEGIN IMMEDIATE` transaction that re-verifies the state and refuses a stale plan. Nothing is ever signed over a state that has not just verified, so tampering cannot be laundered into a new signature.
- **Absence.** A new store signs a genesis commitment (sequence 0, empty set). An existing store with no commitment is inconsistent, never re-initialized.

**Trust chain:** trusted verification key (configuration) → commitment signature → exact revocation set → per-revocation record digest and signature → grant signature bound to the same store id.

### 26.3 Store binding

Every record envelope carries the store's random `storeId`, so grant and revocation signatures are for *this* store. Without it, a genuine commitment from any other store signed by the same key — most simply, the genesis commitment of a file re-created after deletion — could be spliced over this store's rows to state "nothing revoked". With it, the grant fails its signature under the foreign store id (test E+).

### 26.4 Monotonicity

There is no reverse transition and no `unRevoke`. A second revocation of a revoked grant returns the first, unchanged, and signs nothing. Restoring authority means issuing new authority. Append-only triggers (no DELETE on grants, revocations or the commitment; a grant row changes only by linking its revocation once; the commitment only advances by one or is re-signed unchanged) are **defense in depth**. A file-level writer can drop them, so every attack test drops them first.

### 26.5 Schema and compatibility

`aoc.bounded-grant-store.schema.v3`, record format `aoc.bounded-grant-store.record.v2`. v1 and v2 databases are refused at open, unmutated. There is no migration: a v2 file cannot prove its revocation set complete, and signing one for it would vouch for whatever it currently contains. Operators re-issue authority into a fresh v3 store. No production database was touched by this change.

### 26.6 What is blocked, and what is not

| Attacker | Result |
|---|---|
| Database-only writer (any SQL, drops triggers, recomputes unkeyed digests; no trusted signing key) deletes, clears, rewrites, moves, renumbers or re-signs (untrusted key) revocation state | **Blocked.** Reads fail closed (`REVOCATION_STATE_INCONSISTENT` / `AUTHENTICITY_FAILED` / `STATE_CORRUPT`); execution withholds |
| Same, splicing a genuine commitment from another store under the same key | **Blocked** (store binding) |
| Same, restoring a **previously captured** genuine commitment plus the rows it covered, **while the process runs** | **Detected** — the in-process freshness witness refuses a commitment older than one already verified |
| Same, **across a restart** | **Not detected.** Indistinguishable from "never revoked" using the file alone. Old commitment bytes may also remain in WAL/free pages. **CORE-07** (external freshness/anchoring) |
| Holder of the signing key, process, or key configuration | **Not addressed** (AA-001, AA-002; CORE-02) |

### 26.7 Key rotation

The commitment is one row, re-signed only on revocation. So on open, a commitment that verifies under a trusted key other than the active one is re-signed **unchanged** under the active key (best-effort; skipped if the state does not verify or the signer fails). Without this, retiring the old key would make every read in a store with no recent revocation refuse. Tested.

### 26.8 Composition: no silent downgrade

`createSqliteBoundedGrantStore` returns a frozen object registered in a module-private `WeakSet`. `isAuthenticatedDurableBoundedGrantStore` checks that brand at runtime, not by TypeScript shape. Under `persistence.provider === 'sqlite'`, `createEnterprise` refuses a host-supplied `grantStore` without the brand (in-memory store, shape-alike, or a wrapper around the real store) with `EXECUTION_GRANT_STORE_NOT_AUTHENTICATED`, before anything is opened. There is no override flag. Under `memory` persistence any store is still accepted, and module health reports `grantStore: 'unauthenticated'` instead of looking identical to a durable deployment.

**Boundary.** This guards an honest composition mistake. An embedding host runs in the same process and can replace any module, including this check; a malicious host is outside the trust boundary.

### 26.9 Health

`DurableBoundedGrantStore.health()` verifies the commitment and reports `revocationState: 'verified' | 'failed'`, the failure code, and the verified sequence. A store whose revocation state cannot be proven is never `healthy`. The Authority-Controlled Execution module surfaces this (optional criticality, so it does not take the Host out of `ready`; every read it cannot serve withholds).

## 27. CORE-04 — Obligation Discharge State

### 27.1 Why it is an authority artifact

A blocking obligation withholds grant issuance until a configured independent
source's discharge (or waiver) is on record. The discharge store therefore
decides whether authority may be issued: it is authority-material. Before this
section existed the store was protected by an unkeyed per-row digest only, and a
database-only writer could insert a row citing the independent source, recompute
the digest, and make a withheld action execute — reproduced on the canonical
Host before the fix. Deleting a genuine row could also manufacture satisfaction:
the obligation lifecycle orders reports by observation time and refuses
`discharged → waived`, so removing an earlier self-reported discharge could let a
later independent waiver apply. Set completeness is part of the property.

### 27.2 The model (the CORE-01 pattern)

Schema v2 (`obligation-discharges.sqlite`): a store identity
`{storeId (random), organizationId}`; rows with a contiguous `sequence` and a
row digest over the canonical row bound to the store and the position; a hash
chain from a genesis bound to `(storeId, organizationId)`; and one signed head
`{storeId, organizationId, sequence, chainDigest}` — Ed25519 under
`frontera:authority-artifact:obligation-discharge-state:v1`, by the same
`AuthorityArtifactSigner` that signs grants, revocations and the revocation
state (one new structured method, `signObligationDischargeState`; no byte
signing, no new key, no HMAC). Every authoritative read — at open, and before
every issuance decision — verifies the signature against the trusted
verification registry and recomputes the chain over every row; an in-process
witness refuses a regression while the process lives.

- **Never signs over unverified state.** An append verifies the signed head and
  the exact row set (count = sequence, contiguous from 1, every position-bound
  row digest, the recomputed chain, store id, organization) before planning the
  next head; signs it before the write transaction; then, under the write lock
  (`BEGIN IMMEDIATE`), verifies the whole history *again* and requires it to be
  exactly the planned base before persisting row and signed head in **one**
  transaction. A history tampered before or during signing is refused and
  nothing is persisted.
- **Genesis only for an empty file.** A store whose identity, head or tables are
  missing is refused, never re-initialized; the unauthenticated v1 format is
  refused, never upgraded.
- **Key rotation — the CORE-01 rule, reused.** A state that verifies under a
  trusted key other than the active one is re-signed **unchanged** under the
  active key at open, inside a transaction that re-verifies it and writes only if
  it is still exactly that state, then read back; best-effort (an unavailable
  signer leaves a still-valid state). After that the previous key can be retired.

### 27.3 What is blocked, and what is not

Blocked **for a writer without a trusted signing key**: inserting, altering,
deleting, reordering or transplanting a discharge row; re-signing a forged head
with an untrusted key; copying a genuine row or a genuine signed head from
another store (same key, same organization) or another organization; re-labelling
a row's source, outcome, correlation or organization; upgrading the
unauthenticated v1 format. Tested in `obligation-discharge-authenticity.test.ts`
and end to end in `governed-action-obligations-host.test.ts`.

Not blocked: restoring an older, genuinely signed state after a restart
(rollback — CORE-07). Its effect is bounded: the trusted writer records reports
for one obligation in strictly increasing observation time, so every committed
prefix is a prefix of the lifecycle sequence, and because a satisfied obligation
is terminal, a rollback can remove satisfaction but never manufacture it. A
holder of the signing key, or of this process, can sign anything (AA-001,
CORE-02, AA-010). CORE-02 moved `signObligationDischargeState` behind the
external signer with the other four operations (§29).

## 28. CORE-05 — Approval State

### 28.1 Why it is an authority artifact

A completed human approval resumes a committed `approval_required` decision
into a bounded grant: the Kernel adapter turns the grant source's
`authorizationPermitsExercise` on only together with the approval's digest. The
approval store therefore decides whether authority may be issued. Insertion
(a forged approval or quorum), deletion (a rejection, a revocation, an
approval that a later one's count depended on, the request carrying the
requirement snapshot) and rewriting (approver, verdict, the instant that fixes
the proof's expiry) would each widen authority.

### 28.2 The model (the CORE-01 / CORE-04 pattern, unchanged)

Schema v1 (`approvals.sqlite`, the first durable approval format — there is no
unauthenticated predecessor to accept): a store identity `{storeId (random),
organizationId}`; append-only rows `requested` / `approved` / `rejected` /
`requested_changes` / `escalated` / `revoked`, each with a contiguous
`sequence` and a digest over the canonical row (organization, request,
decision, subject digest, kind, subject text, authenticated actor, reviewed
evidence references, reason, recorder, instant) bound to the store and the
position; a hash chain from a genesis bound to `(storeId, organizationId)`;
one signed head `{storeId, organizationId, sequence, chainDigest}` — Ed25519
under `frontera:authority-artifact:approval-state:v1` by the same
`AuthorityArtifactSigner` (one new structured method, `signApprovalState`; the
verifier gains `verifyApprovalState`; no byte signing, no new key, no HMAC).
Every authoritative read — at open, before every command and before every
resumption — verifies the signature and recomputes the exact set. Verified
state before write, genesis only for an empty file, CORE-01 key-rotation
re-attestation and the in-process regression witness are exactly §27.2's.

State, quorum and the approval proof are never stored: they are derived on
every read by replaying the verified rows through approval-runtime's policies
(`ADR-DURABLE-APPROVALS-ON-THE-GOVERNED-PATH.md`). The proof digest is identity,
not authenticity; authenticity comes from the signed head, and the proof
becomes authority only inside a signed grant's `sourceDigest`.

### 28.3 What is blocked, and what is not

Blocked **for a writer without a trusted signing key**: inserting, altering,
deleting, reordering, duplicating or gapping rows; re-signing a forged head
with an untrusted key; transplanting a genuine history (with or without its
genuine head) from another store; a store or row of another organization;
genesis over existing content; laundering a tampered base through a
legitimate later command (before or during signing); a half-written row
without its head. Tested in `approval-authenticity.test.ts` and end to end in
`governed-action-approvals-adversarial-host.test.ts`.

Not blocked: restoring an older, genuinely signed state after a restart
(rollback — CORE-07). Unlike discharges, a prefix **can** be more permissive
than its whole — an approval later revoked, or a request before its rejection
— so a restored earlier genuine state can make a revoked approval usable again
until its own `approvalValiditySeconds` lapse; pinned by a test and assigned to
CORE-07. A holder of the signing key, or of this process, can sign anything
(AA-001, AA-010); CORE-02 moved `signApprovalState` behind the external signer
with the other four operations (§29).

## 29. CORE-02 — External Signer & Key Custody

Decision record: `docs/architecture/ADR-EXTERNAL-AUTHORITY-SIGNER-AND-KEY-CUSTODY.md`.
Code: `src/enterprise/external-authority-signer/`, `authority-authenticity/custody.ts`.

### 29.1 What changed, and what did not

Only **where the private key lives**. The five structured operations, their
domains, the envelope, `AUTHORITY_ARTIFACT_VERSION`, every schema and every
verification path are unchanged; the verifier stays local and public-key-only.

### 29.2 Custody is explicit

`authorityAuthenticity` is `software` (default when no mode is stated; the key
in process, AA-001) or `external` (`AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE=external`).
The external variant has no private-key field; the key variable is never read
under it, and its presence refuses the Host and the composition. External
variables without the mode are refused. No auto-detection, no fallback.

### 29.3 The external signer

An `AuthorityArtifactSigner` with the same five methods, built by
`establishExternalAuthorityArtifactSigner` over an `ExternalAuthoritySignerTransport`
(shipped: HTTP — https anywhere, http to loopback only, bearer credential, no
redirects, response cap). Protocol `frontera.external-authority-signer.v1`: a
non-signing `GET /v1/identity` and one `POST /v1/sign/<artifact>` per operation.
A grant travels as its canonical bytes and must round-trip; commitments as
their closed fields. **There is no byte-signing operation anywhere on the
boundary.** A provider that only offers generic signing sits behind a custody
server that speaks this protocol.

### 29.4 No private key in the Host (AA-001, external custody)

The composition's external branch returns before any code that parses a
private key, and has no fallback branch (structural test). Proven end to end
on the canonical Host (`bootEnterpriseHost()`, production profile) with the
signer as a **separate process** that generated its own key file — the test
process reads only its public half — and through the **shipped launcher**,
where the running Host's `/proc/<pid>/environ` holds no private key. All five
operations run; every persisted artifact then verifies with public keys alone.

### 29.5 Identity is pinned, never learned

The pin is the trusted-registry entry for the configured key id: key id,
algorithm and SPKI public key. Before any store opens, the service's identity
must match all three and offer exactly the protocol, the artifact version and
the five operations; otherwise the Host does not start. The advertised public
key is compared, never trusted or added (no TOFU). Rotation is configuration
and restart; a signature under any other key — even a still-trusted historical
one — is refused at runtime.

### 29.6 Returned signatures are verified before persistence

An answer is accepted only as the exact four-field envelope, under the pinned
key id and algorithm, current artifact version, exact encoding and width, and
only if it **verifies locally over the exact artifact sent, under the pinned
key**. Refusals carry a closed reason: `EXTERNAL_SIGNER_TIMEOUT`,
`_UNREACHABLE`, `_UNAVAILABLE` (5xx, 429), `_AUTHENTICATION_FAILED`,
`_REFUSED`, `_IDENTITY_MISMATCH`, `_MALFORMED_RESPONSE`,
`_CAPABILITY_UNSUPPORTED`, `_SIGNATURE_INVALID` — no provider text, body,
credential or payload. The stores' read-back remains; CORE-02 added it to the
discharge and approval appends, which previously wrote their head unverified.

### 29.7 Outage semantics (AA-004)

| Operation during a signer outage | Result |
|---|---|
| Read / verify any grant, revocation state, discharge, approval | **works** — local verification |
| Exercise an existing grant | governed by the normal rules; no signer involved |
| Issue a grant | fails; nothing written |
| Revoke a grant | fails; nothing written; admin API `503 AUTHORITY_SIGNER_UNAVAILABLE`, `recorded: false`, "remains exercisable" |
| Record a discharge / an approval command | fails; nothing written; not accepted |
| Open an approval request | withheld `unavailable` |
| Create a new store (genesis) | fails; the file is left uninitialized |
| Re-attest on rotation | skipped; the old-key state stays valid while that key is trusted |
| Emergency stop | **works** — independent of the signer; withholds exercise; not a revocation |
| `/health` | `degraded`, `authoritySigner.state: unavailable` + reason; `identity` and `lastSigning` shown separately. No signature is spent. A signing failure persists until a verified signature succeeds (CORE-02R, §29.11). `/ready` unaffected |
| Host restart | refused until the signer's identity can be proven (AA-011) |

Every call is bounded: per-attempt `AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS`
(default 5 000) × `…_MAX_ATTEMPTS` (default 2, max 3); only timeout /
unreachable / unavailable are retried. A timed-out call may have been signed
remotely; that signature was never persisted and confers nothing — authority is
committed, verified state.

### 29.8 Cost (AA-005)

Issuance preflight (already issued, precluded, `commitGuard`) before signing;
the transaction re-asks everything after signing. Expected calls: genesis 1 per
store; grant 1; duplicate/precluded/ineligible issuance 0; revocation 2;
duplicate/unknown revocation 0; discharge 1; approval event 1; rotation 1 per
store; health 0. Unavoidable waste: eligibility changing in flight, a stale
revocation plan (re-plan, sign again), a retried lost response.

### 29.9 Byte compatibility

External and software signers produce identical signatures for all five
artifacts under the same key (tested). Moving a deployment between custodies
for the same key needs no re-signing; moving to a new key follows §13.

### 29.10 What external custody does not give

- A compromised Host can **request** signatures while it holds the service
  credential (AA-010). No independent service-side authorization ships.
- AA-002 is narrowed, not closed: rewriting endpoint, registry and
  configuration together still controls trust.
- AA-004 is designed, bounded and observable, not closed.
- AA-006: `ed25519-v1` only.
- The reference custody service is **not an HSM**: a file-backed key in a
  loopback process. No mTLS or workload identity in the shipped transport.

### 29.11 Post-merge review hardening (CORE-02R)

Four defects in the code as merged by PR #152, each reproduced on
`main @ 0778b74` and then fixed. None required a format, protocol, domain,
version or schema change. Full record in ADR §6.

- **Supplied stores (P2-A).** The custody brand said where a store's key
  lives, not which key or trust set it uses. A supplied store signed by
  another custody service was adopted, and the configured signer went
  uncontacted. Under external custody, `createEnterprise` now refuses every
  supplied grant, obligation and approval store and builds all three over the
  configured, proven boundary (AA-INV-035). Software custody keeps injection.
- **Truthful signing health (P2-B).** A successful identity probe erased a
  signing failure. Now `identity` and `lastSigning` are separate, and only a
  verified signature clears `lastSigning` (AA-INV-036). Probes are
  single-flight and rate-bounded by
  `AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS` (default 5 s).
- **Startup retries (P2-C).** The handshake shares the signing retry loop:
  availability failures are retried up to `maxAttempts`, answers never are
  (AA-INV-037). A runtime probe is one attempt.
- **Real process environment (P2-D).** `bootEnterpriseHost` under external
  custody refuses when `AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM` is present
  in `process.env`, whatever `options.env` says (AA-INV-038).

Residuals are unchanged: AA-010, AA-002 (narrowed), AA-004 and AA-011. The
bounded retry tolerates a transient blip, not an outage.

---

---

## Change Control

1. A new `AuthorityArtifactSigner` or `AuthorityArtifactVerifier` implementation must be added to §10/§11 before it ships and must satisfy every AA-INV in §5.
2. An AA-INV may only be strengthened by evidence. Editing the prose is not promotion.
3. §23's claims travel with their scope. A restatement omitting "in the durable authority store" or "without access to a trusted signing key" is an overclaim.
4. §24 is not advisory. Adding a §23 claim that contradicts a §24 row requires deleting that row, and deleting it requires the evidence that makes it false.
5. Findings close on evidence, not documentation. AA-001 closed **for external custody** when the canonical-Host and launcher E2E proved the key outside the process (CORE-02); it remains open for software custody. AA-004 closes only with a signer-independent revocation path.
6. Any new algorithm entry must be justified against AA-INV-008 and AA-INV-018, and must not introduce negotiation, fallback, or try-until-one-verifies.
7. No unsigned or verification-optional mode may be added to the durable store. If backwards compatibility ever appears to require one, that is a design review, not a patch.
8. A new custody (a new `ExternalAuthoritySignerTransport`, a KMS/HSM adapter) must keep the five structured operations, the pinned-identity handshake, local pre-commit verification and the closed failure taxonomy (§29), and must not introduce a fallback between custodies.
