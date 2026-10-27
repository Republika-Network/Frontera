# AUTH-02 — Human Identity and Passkey Credential Lifecycle

- Status: **Implemented as a module, not exposed.** No HTTP route, no Host composition, no deployment.
- Module: `src/enterprise/human-identity/`
- Tests:
  - `src/enterprise/__tests__/auth02-human-identity.test.ts`
  - `src/enterprise/__tests__/auth02-human-identity-structure.test.ts`
  - fixture: `src/enterprise/__tests__/auth02-software-authenticator.ts`
- New dependency: `@simplewebauthn/server` 14.0.3 (exact pin), with 23 transitive packages (§8).
- Predecessors: AUTH-00 (assessment), AUTH-01 (#208, connected approval → execution; regression baseline).

## 1. What AUTH-02 establishes, and what it does not

AUTH-02 answers **who the human is** and **which passkeys belong to that human**.

| Question | Answered here | Answered by |
|---|---|---|
| Who is this individual human approver? | yes: `HumanPrincipal` | AUTH-02 |
| Which credentials are theirs; are they still valid? | yes: `PasskeyCredentialView` | AUTH-02 |
| Did this human just prove presence with one of their passkeys? | yes: `RecognizedHuman` | AUTH-02 |
| May this human approve this request? | **no** | CORE-05, from live Kernel-Authority standing |
| Did this human authorize *this exact* decision? | **no** | AUTH-03 |
| Phone UI, sessions, notifications | **no** | AUTH-04/05 |

**Possession of a passkey grants nothing.** A `RecognizedHuman` carries no
session, token, role, permission or authority, and the module imports nothing
from CORE-05, Kernel Authority, grants, capabilities or execution. A structural
test enforces this. This PR changes nothing in CORE-05, G-02, the execution
binding or receipt verification. AUTH-01 remains green as the regression
baseline.

## 2. Identity model

`HumanPrincipal`:

| Field | Notes |
|---|---|
| `operatorId` | A configured CTRL-02 operator id. A principal is never created for anything else. |
| `actorRef` | `operator:<operatorId>`, the CTRL-04 identity bridge. CORE-05 resolves approver standing for this actor. |
| `organizationId` | The Host's single organization, taken from the store. Never from a request. |
| `displayName` | Shown to administrators. |
| `state` | `active` or `revoked`. |
| `createdAt`, `createdBy` | Creation metadata. |
| `revokedAt`, `revokedBy`, `revocationReason` | Revocation metadata. |

Each principal also has a random 256-bit **user handle** (the WebAuthn `user.id`).
It is opaque, not the operator id, so the authenticator stores no internal
identifier.

Pilot scope:
- one organization per Host and one persistent Host process;
- no multi-tenant identity platform and no federation;
- no passwords or password fallback.

## 3. Administration and enrolment

Administrative acts require an `IdentityAdministrator`:
- Only `identityAdministratorFor(principal)` can make one.
- It is made from the `EnterpriseOperatorPrincipal` that the existing operator authenticator produces.
- It requires a **CTRL-02 operator credential** with role `organization-administrator`. A legacy CTRL-01 administrator is refused.
- It is branded through a module-private `WeakSet`, so a structurally identical object is refused.
- Its organization must equal the store's.
- No new operator role or permission is introduced.

**Enrolment.**
- An administrator authorizes **one named human** to register **one** passkey.
- The token `fre1.<enrolmentId>.<secret>` carries a 256-bit CSPRNG secret.
- It is returned once. Only its SHA-256 verifier is recorded.
- It is short-lived (default 900 s, maximum 3600 s) and revocable.
- Every failure is the same `HUMAN_IDENTITY_ENROLMENT_INVALID`.

**Registration.**
1. `beginRegistration(token)` issues a fresh 256-bit challenge, durably bound to the enrolment and the human. It expires after 300 s by default, 600 s at most.
2. `finishRegistration(token, response)` runs the checks in §4.
3. It then commits, in **one transaction**:
   - the credential;
   - the enrolment's consumption;
   - the challenge's consumption.

**Interrupted ceremonies.** An abandoned or refused ceremony consumes nothing; the enrolment stays usable until it expires. A commit that cannot take the write lock records nothing. The same response then commits exactly once.

**Trust assumption.** The administrator who authorizes an enrolment could use
its token themselves. Delivering the token out of band to the named human is
an operational control. Two-person enrolment is a possible later hardening; it
is not claimed.

**No public bootstrap surface.** Nothing is exposed over HTTP. Wiring
enrolment to the operator plane (AUTH-03 or AUTH-04) is a separate, reviewed step.

## 4. WebAuthn verification

All cryptographic and protocol verification is done by `@simplewebauthn/server`:
- challenge, RP ID hash, origin and ceremony type;
- user presence and **user verification (always required)**;
- attestation statement (`none` requested; other formats are verified or refused by the library);
- credential public-key decoding;
- signature;
- authenticator flags.

No cryptographic primitive is implemented in Frontera.

Policy added around the library (`webauthn.ts`):

| Check | Why |
|---|---|
| Closed response shape: base64url strings only, `rawId === id`, known transports | Refuse malformed or unexpected input before verification |
| Client data refused when `crossOrigin` is true or a `topOrigin` is present | The Authority surface is never embedded. The library does not check this for registration |
| Origin on the explicit allow-list (also checked by the library) | No caller-supplied origins |
| Algorithms ES256, EdDSA, RS256 only | No post-quantum or other unqualified algorithm |
| The registered key must import through Node's `crypto.createPublicKey` (P-256 point on the curve, Ed25519, or RSA of at least 2048 bits) | A malformed key is refused at registration, not at first use. Uses the library's COSE decoder and Node's key parser |
| Durable challenge, single-use, ceremony-bound, expiring, consumed in the committing transaction | Replay resistance across restarts |
| `userHandle`, when present, must be the credential owner's | Incorrect ownership |

### Relying party

- **RP ID.** The intended production RP ID is `authority.frontera-systems.com`. It is configuration only: no DNS or TLS was changed and nothing was deployed.
- **Origins.** Every origin must be `https://` on the RP ID or one of its subdomains. A bare origin is required: no path, query or trailing slash.
- **Loopback.** Only an explicit `test-loopback-only` mode allows loopback, bound to RP ID `localhost` and `http://localhost` origins. It cannot weaken a real configuration.

### Counters

- **Synced passkeys** usually never count (signCount stays 0). That is accepted: 0 after 0 is not a regression.
- **Counting authenticators.** If either counter is above 0, a presented counter that does not advance is refused as `HUMAN_IDENTITY_COUNTER_REGRESSION`.
- **When the rule is applied.** Only after the signature has verified, so the regression is attributable to the credential's own key (a possible clone), not to unauthenticated input. It is then recorded as `credential_counter_anomaly`.
- **No automatic revocation.** The credential is not silently trusted for that attempt, nor automatically revoked. The anomaly is evidence for an administrator.
- **Device-bound claims.** `deviceType` and `backedUp` are recorded. A synced (`multiDevice`) passkey is never treated as device-bound. Attestation is not verified against vendor roots, so nothing is claimed about the authenticator model.

## 5. Durable storage

The store is `openSqliteHumanIdentityStore`, one SQLite file of its own.

**Chain.** An append-only history (`human_identity_records`) is hash-chained exactly as CORE-05's approval log:
- a store-bound genesis;
- per-row digests over canonical JSON;
- a head `{storeId, organizationId, sequence, chainDigest}`.

**Verification.** Every authoritative read recomputes the whole chain. A tampered, deleted, reordered or foreign row makes the store refuse, `HUMAN_IDENTITY_STORE_CORRUPT`, at read and at open.

**Writes.** All writes use `BEGIN IMMEDIATE`, WAL and `synchronous=FULL`. The guard sees the verified history under the write lock, so concurrent writers cannot double-register a credential id or double-consume an enrolment or challenge. Partial unique indexes and append-only triggers are defense in depth.

**At rest.** Only public keys, ids, counters, timestamps and verifiers of random secrets are stored. Never an enrolment secret or any private key (tested).

**Creation and organization.** A store is created only by explicit initialization (`create: true`). A file of another organization or schema is refused.

**Production migrations.** None: this is a new, separate file.

### Signed head and cross-restart rollback (delivered by AUTH-03)

AUTH-03 signs this store's head with the deployment authority key, under its
own domain (`frontera:authority-artifact:human-identity-state:v1`), after a
founder decision narrowing CORE-02 TD-5 to exactly this store-state commitment.
Every read verifies the signature and the whole chain, and the head is
anchored at the CORE-07 witness (state kind `human-identity-state`) when
freshness is composed. The store is now schema v2; a v1 file is refused, never
migrated. See `AUTH-03-DECISION-BOUND-HUMAN-AUTHORITY.md` §3–§4.

## 6. Revocation

- **By an administrator.** Durable evidence: who, when, why.
- **By the owner.** Only through a fresh, user-verified assertion from one of their own active credentials, over an owner-revocation challenge bound to the target credential. Another human's credential, a challenge for another target, or a plain authentication challenge are refused.
- **Effect.** A revoked credential is refused from the next read, including after a restart. Its id can never be registered again (no resurrection).
- **Duplicates.** A second revocation is refused as `HUMAN_IDENTITY_ALREADY_REVOKED`.
- **Revoking a human** refuses all of their credentials and enrolments.

**Boundary.** Revoking a passkey or a human does **not** claim to revoke
anything already done with it:
- an issued grant or execution capability lives its own G-02 lifetime (at most 60 s);
- a recorded approval stays recorded;
- CORE-05 still re-resolves the approver's Kernel-Authority standing at every read, which is the existing mechanism for withdrawing an unused approval.

## 7. Tests

`auth02-human-identity.test.ts` runs the production verifier, driven by a
spec-faithful software authenticator. The authenticator builds real CBOR
attestation objects, authenticator data and ECDSA P-256 signatures with Node's
crypto, and its private key never leaves the test process. The relying party is
the intended production configuration; nothing touches a network.

Coverage:
- **Correct registration.**
- **Wrong or hostile client data:** wrong challenge, origin or RP ID; cross-origin and embedded ceremonies; wrong ceremony type.
- **Expired and reused challenges,** including across a restart, and a challenge used for another enrolment or ceremony.
- **Credential ids:** duplicates, including for another human and after revocation.
- **Unknown operator and unknown principal.**
- **Unauthorized administration:** every non-administrator role, legacy administrators, forged administrator objects, and another organization.
- **Enrolment tokens:** malformed, wrong secret, revoked, expired, consumed.
- **Invalid attestation data:** unsupported format, forged `packed` statement, `none` with a statement, missing attested data.
- **User presence and verification missing.**
- **Invalid signature.**
- **Incorrect ownership:** a foreign user handle, and owner revocation with another human's credential.
- **Revoked credential and revoked human.**
- **Replay after restart.**
- **Concurrency:** two connections racing for one enrolment and for one credential id.
- **Interrupted persistence and ceremony recovery.**
- **Malformed public keys:** off-curve point, truncated coordinate, RSA below 2048 bits, unsupported algorithm.
- **Malformed response shapes.**
- **Cross-organization stores.**
- **Counter rules:** advance, repeat, regression, reset to 0, synced 0/0/0.
- **Recovery after device loss.**
- **Owner revocation.**
- **Tamper detection,** and the triggers as defense in depth.
- **No secrets at rest.**

**Test vectors.** The software authenticator follows the WebAuthn L2 byte
layouts. The library's own test suite covers platform-specific attestation
formats (TPM, Android, Apple), which AUTH-02 neither requests nor trusts.

## 8. Dependency assessment

`@simplewebauthn/server` 14.0.3 (MIT):
- maintained since 2020, 103 releases, latest 2026-09-25;
- dual ESM/CJS with types; Node ≥ 20 (Frontera requires ≥ 22).

It resolves 24 new packages, all permissive:
- `@simplewebauthn/server`;
- `@hexagon/base64`, `@levischuck/tiny-cbor`;
- `@peculiar/asn1-*` (13 packages), `@peculiar/utils`, `@peculiar/x509`;
- `asn1js` (BSD-3-Clause), `pvtsutils`, `pvutils`;
- `reflect-metadata` (Apache-2.0);
- `tsyringe` and its nested `tslib` (0BSD).

The lockfile change is **additive only**: no existing entry moved.

**Advisories (GitHub Advisory Database, at implementation).** The only one in
the tree is GHSA-6hxq-p678-4hr2 (Low), affecting `@simplewebauthn/server`
≤ 13.3.1. 14.0.3 is not affected. No other new package has an advisory.

**Not inherited:**
- none of the `next` / `postcss` / `nanoid` / `source-map-js` tree tracked by issue #210;
- no reuse of the `enterprise-host-sdk` (CodeQL #14);
- no reuse of `agent-passport-web` sessions or login.

**Runtime footprint.**
- The library is loaded lazily from `webauthn.ts` only. A Host that does not compose human identity never loads it.
- `reflect-metadata`, loaded by the library's X.509 dependency, augments the global `Reflect`. That is acceptable for a lazily loaded verifier, and recorded here.

## 9. AUTH-03 prerequisites

1. **Signed identity head and CORE-07 freshness.** Delivered by AUTH-03 (§5).
2. **Decision-bound challenge.** Delivered by AUTH-03 (`AUTH-03-DECISION-BOUND-HUMAN-AUTHORITY.md`). The CORE-05 actor stays `operator:<operatorId>`.
3. **Operator-plane wiring.** How a recognized human reaches the CORE-05 command without a static bearer becoming the approval authority. This needs a reviewed decision on the session or BFF boundary (AUTH-04) and on routes.
4. **Composition.** Opening this store in `bootEnterpriseHost` (path, permissions, backup per PROD-02), with the relying-party configuration from deployment configuration.
5. **Separation of duties.** The pilot CTO holds no agent credential and no administrator role (AUTH-00 G).
