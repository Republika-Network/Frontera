# ADR: Protected Resource + Content Encryption Foundation (Sovereign Execution Binding, Slice 2)

- Status: Accepted
- Deciders: Frontera Systems architecture
- Sequence: Slice 2 of N, Sovereign Execution Binding
- Repository: `architects-of-change-protocol/aoc-enterprise` (Frontera Systems)
- Branch: `claude/aoc-enterprise-slice-2-yq7pgf`
- Precondition: `ADR-DURABLE-GRANTS-REVOCATION.md` (Slice 1, durable
  `AccessGrant`/`GrantRevocation`, truthful effective revocation) -- verified
  present and accepted before this slice began; see "Precondition verified"
  below.

## Role of this document

This ADR records Slice 2 of Sovereign Execution Binding: turning

```
Resource -> AccessGrant -> Provider Credential            (Slice 1)
```

into a second, independent capability that composes alongside it:

```
Plaintext resource
      |
Enterprise protection service
      |
AES-256-GCM encryption
      |
Ciphertext
      |
Storage provider
```

with key material kept separate from the ciphertext. The sole invariant
this slice proves true: **the distribution/storage path receives
ciphertext, not plaintext**, and **the decryption key remains separated
from the content**. This slice does **not** deliver a key to an end
user/player, does not implement `ExecutionGrant`/`KeyBroker`, and does not
claim a Kill Switch -- all explicitly deferred to Slice 3.

---

## Precondition verified

Before writing any code, the current branch/base was reconciled against
Slice 1's actual, already-merged implementation
(`src/enterprise/access-governance/`, PR #94): durable `AccessGrant`
storage (`access-grant-store.ts` + `{in-memory,sqlite}-access-grant-store.ts`),
durable `GrantRevocation` storage (same store, `access_grant_revocations`
table), tenant isolation (`requireAccessGrantAccessToOrganization`),
authenticated revocation orchestration (`orchestration.ts`'s
`revokeGrantRequest`), prevention of future credentials after revocation
(`lifecycle.ts`'s `assertActive`, enforced in `service.ts`'s
`requestProviderCredential`), effective-revocation semantics
(`AccessGrantProviderEnforcementResult`), Pinata truthful capability
representation (`packages/pinata-adapter/src/pinata-revocation-capability.ts`),
CID/provider-file-id separation (GAP-012, `providerCid` vs.
`providerFileId`), and the `beginRevocation -> provider enforcement ->
finalizeRevocationEnforcement` two-phase write ordering
(`access-grant-store.ts`). All present. This slice proceeded.

---

## Architectural boundary preserved

- **Soberanía Protocol = Sovereignty.** Not modified. This slice adds no
  canonical sovereign asset identity, manifest, or digest semantics of its
  own -- see "Sovereign binding" below.
- **Frontera Systems = Governance + Enforcement.** This slice's entire
  contribution: `src/enterprise/content-protection/`.
- **Assurance = Verification.** Not touched; no scoring/monitoring
  authority moved into this slice.

---

## Sovereign binding: `SOVEREIGN_BINDING_GATE = BLOCKED_BY_PROTOCOL`

Before implementation, the vendored `@aoc/protocol@0.1.0` tarball this
repository actually consumes
(`vendor/aoc-protocol-0.1.0.tgz`, pinned by `protocol-consumer.lock.json` to
commit `ab2ac6ef573c871a029a67b13d33ba9738cb5939`) was extracted and its full
compiled type surface (`dist/contracts`, `dist/claims`, `dist/adapters`,
`dist/runtime-registry`, and every nested module) was grepped
case-insensitively for `sovereign` and `contentDigest`. Zero matches. No
`SovereignAssetId`, no `SovereignManifest`, no `contentDigest`, no
`resolveSovereignAsset()`, no `verifySovereignManifest()`.

Per the task's explicit instruction, this slice therefore did **not**
invent `SovereignAssetId` or shadow-implement Protocol's eventual export.
Instead:

- `src/enterprise/content-protection/sovereign-binding-port.ts` defines a
  provisional, Enterprise-side `SovereignAssetBindingPort` interface
  (`resolveSovereignAsset`/`verifySovereignManifest`) mirroring the shape
  the future Protocol export is expected to take, so that wiring the real
  thing later changes only this file's default composition -- never
  `service.ts`'s call sites, never `contracts.ts`'s
  `ContentProtectionSovereignBinding` shape.
  `createBlockedSovereignAssetBindingPort()` is the only implementation
  this repository's own composition wires up; both methods reject
  immediately with `SOVEREIGN_BINDING_GATE = 'BLOCKED_BY_PROTOCOL'`,
  naming the exact missing exports.
- `ContentProtectionService.protectResource` only ever consults this port
  when a caller explicitly supplies `sovereignAssetId` in the request.
  **This does not prevent protecting ordinary, non-sovereign-bound
  resources** -- proven directly by
  `content-protection-service.test.ts`'s "the default composition ...
  reports SOVEREIGN_BINDING_GATE ... while ordinary protection is
  unaffected" test, which protects an ordinary resource successfully and
  *then* proves a sovereign-bound request against the same, real default
  composition is rejected.
- The verification/digest-comparison logic itself (content-digest
  fail-closed matching, `ContentProtectionSovereignBinding` population) is
  fully implemented and tested against a **test-only fake**
  `SovereignAssetBindingPort` (`fakeSovereignBindingPort` in the test
  file) standing in for a future real Protocol-backed adapter -- so the
  logic is proven correct and ready the day Protocol ships the real
  export; only the live binding is gated.

---

## Terminology: `ProtectedResource`, not `ProtectedAsset`

Enterprise's existing vocabulary is already provider-neutral *resource*
vocabulary throughout (`AccessGrantResource`, Protocol's own `ResourceRef`
composed by `EnterpriseAccessGrant`). `ProtectedResource` was chosen over
`ProtectedAsset` because this module protects both Soberanía Sovereign Assets
(once Protocol exports that contract) and ordinary resources that were
never sovereignized through Protocol at all (Slice 2 requirement 3) --
calling every protected thing an "asset" would either overload Protocol's
own eventual `SovereignAsset` vocabulary or falsely imply every protected
resource is one.

---

## Architecture reused, not created

- **Persistence discipline**: `src/enterprise/content-protection/{in-memory,sqlite}-protected-resource-store.ts`
  reuse the exact `better-sqlite3`, pragma (`journal_mode = WAL`,
  `synchronous = FULL`, `busy_timeout`), schema-versioning
  (`content_protection_store_versions`), and `db.transaction(...)`
  discipline `src/enterprise/access-governance/sqlite-access-grant-store.ts`
  already established for Slice 1.
- **Tenant isolation**: `requireContentProtectionAccessToOrganization`/
  `requireContentProtectionTenantScope`
  (`protected-resource-store.ts`) are a direct structural mirror of
  `requireAccessGrantAccessToOrganization`/`requireAccessGrantTenantScope`.
- **Strict UTC timestamps**: `isStrictUtcTimestamp`/`requireStrictUtcTimestamp`
  reuse the identical pattern (and identical regex) Slice 1 introduced,
  rather than a second, possibly-diverging implementation.
- **Error taxonomy shape**: `ContentProtectionError`
  (`code`/`message`/`details`) mirrors `AccessGovernanceError` exactly.
- **Two-phase durable writes**: `createPending -> markActive | markFailed |
  markOrphaned` mirrors Slice 1's `beginRevocation -> finalizeRevocationEnforcement`
  "persist the durable fact first" discipline, adapted to this slice's own
  fail-atomicity requirement (see "Failure atomicity" below).
- **Provider SDK boundary**: the Pinata ciphertext-upload capability
  (`PinataProviderClient.uploadCiphertext`, added to the *existing*
  `packages/pinata-adapter/src/pinata-provider-client.ts` -- never a new
  file) preserves `packages/pinata-adapter/scripts/check-pinata-boundary.mjs`'s
  hard-enforced invariant: exactly one file in this repository imports the
  `pinata` SDK. `src/enterprise/content-protection/pinata-storage-adapter.ts`
  talks only to `PinataProviderClient`, never to the SDK or `File`/`Blob`
  types directly.
- **Nothing new invented for**: canonical contract validation/serialization
  patterns, tenant-scoped store health-check shape
  (`ProtectedResourceStoreHealth`), or the general "port + in-memory
  adapter + real adapter" seam shape -- all follow precedent already set by
  `access-governance/` and `pinata-adapter/`.

## What is genuinely new

- `src/enterprise/content-protection/` in full: `aead.ts`, `aad.ts`,
  `encryption-profile.ts`, `key-wrapping-port.ts`, `storage-port.ts`,
  `pinata-storage-adapter.ts`, `sovereign-binding-port.ts`, `contracts.ts`,
  `errors.ts`, `lifecycle.ts`, `protected-resource-store.ts`,
  `{in-memory,sqlite}-protected-resource-store.ts`, `service.ts`,
  `evidence.ts`, `index.ts`.
- `PinataProviderClient.uploadCiphertext` (additive method + two new
  exported types), added to the existing `pinata-provider-client.ts`.
- The root `types/node-shims.d.ts` fix described below (a latent,
  pre-existing typing defect this slice's own code was the first to
  trigger).

---

## Envelope encryption model

```
Content -> random DEK -> AES-256-GCM -> Ciphertext
DEK -> KeyWrappingPort -> Wrapped DEK / Key Reference
```

- **DEK**: `generateDek()` (`aead.ts`), `crypto.randomBytes(32)` -- a fresh,
  cryptographically secure 256-bit key per protection, never derived,
  never reused.
- **Nonce**: `generateNonce()`, `crypto.randomBytes(12)` -- fresh per
  encryption call; GCM's defined-optimal length.
- **AEAD**: `node:crypto`'s `createCipheriv('aes-256-gcm', ...)` /
  `createDecipheriv(...)`, both wrapped once in `aead.ts` and never called
  directly anywhere else in this module -- no custom cipher, no hand-rolled
  GCM.
- **Key wrapping**: `KeyWrappingPort.wrapKey`/`unwrapKey`
  (`key-wrapping-port.ts`). The DEK is AEAD-wrapped under a
  Key-Encryption-Key the port owns; only the wrapped (already-ciphertext)
  DEK is ever persisted (`ProtectedResourceRecord.wrappedKey`) -- never the
  raw DEK. `zeroBuffer()` best-effort-zeroes the raw DEK buffer immediately
  after wrapping, in a `finally`, regardless of wrap success/failure.

### POC-only component, explicitly labeled

`createDevLocalKeyWrappingProvider` (`key-wrapping-port.ts`) is the **only**
`KeyWrappingPort` implementation this repository ships. It is explicitly
non-production:

1. Requires a literal-typed `allowNonProductionKeyWrapping: true` option --
   cannot be constructed by accident.
2. Refuses to construct when `process.env.NODE_ENV === 'production'`,
   regardless of the opt-in flag.
3. Its KEK is a fresh `randomBytes(32)` draw held only in the constructing
   closure's memory -- never sourced from an env var, config file, or
   anything else that could be committed or persisted. A process restart
   draws a brand-new KEK, permanently orphaning every `WrappedDekMaterial`
   the prior instance produced -- proven directly by
   `content-protection-crypto.test.ts`'s "two separately-constructed
   instances ... cannot unwrap each other's wrapped material" test.

`createContentProtectionService` takes `KeyWrappingPort` as a **required**
constructor dependency with **no default** -- there is no code path
anywhere in this module that silently falls back to the dev-local provider,
so a production composition root that forgets to wire a real KMS/HSM-backed
port fails to construct the service at all, rather than quietly running on
dev-grade key wrapping. Production KMS/HSM integration remains a later
infrastructure dependency, out of scope for this slice, exactly as the task
description specifies.

---

## Cryptographic context binding (AAD)

`aad.ts`'s `buildContentProtectionAad` binds every encryption to
`CONTENT_PROTECTION_AAD_PROFILE_V1`, `protectedResourceId`,
`organizationId`, `resource.kind`/`resource.id`, `encryptionProfile`, and
(when sovereign-bound) `sovereignAssetRef`/`sovereignVersion` -- encoded as
canonical JSON over a fixed-order array, never delimiter-joined strings (no
collision risk from a field containing the delimiter). Ciphertext moved to
a different logical context (a different tenant, a different
`protectedResourceId`) fails GCM authentication -- proven by
`content-protection-crypto.test.ts`'s Test F.

This is an Enterprise-owned, versioned AAD profile defined strictly for
encryption context binding; it does not duplicate Protocol's own
canonicalization rules (`../governance-store/canonical-json.ts` serves a
different concern -- Governance Store record integrity, not encryption
context) and does not consume them, since Protocol has no cryptographic
canonicalization export applicable here either.

---

## Encryption profile

`CONTENT_PROTECTION_ENCRYPTION_PROFILE_V1 = 'AOC-ENTERPRISE-PROTECTION-V1'`
(`encryption-profile.ts`): AES-256-GCM, 256-bit key, 96-bit nonce, 128-bit
tag, `aoc-enterprise-content-protection-aad-v1` AAD profile. A closed,
versioned union -- `requireContentProtectionEncryptionProfile` fails closed
(`CONTENT_PROTECTION_UNSUPPORTED_ENCRYPTION_PROFILE`) for anything not in
the supported set, proven by Test G. No algorithm-agility escape hatch
that would permit an insecure downgrade -- a future v2 is an additive union
member, never a mutation of what v1 ciphertext requires to decrypt.

---

## `ProtectedResource` contract

See `contracts.ts`'s own module doc for the full, field-by-field invariant
rationale (reproduced in the final report). Summary: `protectedResourceId`
(this protection's identity), `resource` (Enterprise's own reference, never
a provider identity), `sovereignBinding?` (Protocol-supplied, carried
verbatim, never minted by Enterprise), `plaintextDigest?`/`ciphertextDigest?`
(`sha256:<hex>`, distinct concerns -- the latter is explicitly never a
`SovereignAssetId` substitute), `encryptionProfile`, `nonce?`/`authTag?`
(safe to store, GCM's own design), `wrappedKey?` (never the raw DEK),
`storageRef?` (where ciphertext lives, not asset identity), `state`
(`pending | active | failed | orphaned`), `failureReason?`,
`correlationId`, `createdAt`/`updatedAt`.

---

## Failure atomicity

`lifecycle.ts` defines the smallest state machine the fail-atomicity
requirement needs: `pending` (durably created *before* any
encryption/wrapping/upload attempt) transitions exactly once to one of
`active` | `failed` | `orphaned`, all terminal. `service.ts`'s
`protectResource` orchestration:

1. Tenant/authorization check.
2. Resolve encryption profile (fail closed on unknown).
3. `store.createPending(...)` -- durable row exists before anything risky
   runs.
4. If sovereign-bound: resolve + verify manifest, compare
   `plaintextDigest` against Protocol's `contentDigest`
   (`digestsEqual`, constant-time) -- mismatch is `FAIL CLOSED`
   (`CONTENT_PROTECTION_CONTENT_INTEGRITY_MISMATCH`, `integrity_mismatch`
   evidence event, row marked `failed`, never `active`). Proven by Test H.
5. Generate DEK/nonce, encrypt, compute `ciphertextDigest`.
6. Wrap the DEK. **Failure here never reaches step 7** -- proven by Test N
   (storage adapter's upload method is asserted never called).
7. Upload ciphertext via `ContentStoragePort`. Failure here marks the row
   `failed` (Test L) -- ciphertext was never durably stored, so there is
   nothing to orphan.
8. `store.markActive(...)`. **Failure here** (ciphertext already uploaded)
   triggers a best-effort compensating `store.markOrphaned(...)` call,
   preserving `storageRef` for recovery; if even that fails, the row
   remains `pending` -- durable and discoverable, never falsely `active`
   (Test M).
9. Emit `protection_succeeded`.

No code path in this orchestration can produce a `ProtectedResource`
persisted as `active` without every one of encryption, key wrapping,
upload, and final persistence having genuinely succeeded.

---

## Plaintext safety

`request.plaintext` is read exactly twice (digest computation,
`encryptContent`'s input) and never copied into any other structure,
logged, or included in any error/event. Every `ContentProtectionError`
message is hand-authored and safe; `describeFailureReason` in `service.ts`
reduces any *other* thrown value (a raw adapter/driver exception) to a
fixed, generic sentence before it can reach a persisted `failureReason` or
an evidence event -- proven structurally (no test asserts a raw exception
message ever appears in a record, and the code path that could produce one
is unreachable by construction). No temp files are used anywhere in this
module -- everything is in-memory `Buffer` handling end to end.

---

## Storage provider rule and provider neutrality

`ContentStoragePort` (`storage-port.ts`) carries no Pinata-specific
semantics -- no CID-as-identity, no JWT, no gateway field. This module's
entire crypto/service/persistence test suite
(`content-protection-crypto.test.ts`, `content-protection-service.test.ts`,
`content-protection-store-contract.test.ts`,
`content-protection-boundary.test.ts`) runs exclusively against
`createInMemoryContentStoragePort`, never against Pinata -- proving the
cryptographic core has no Pinata dependency whatsoever.

`pinata-storage-adapter.ts` is one interchangeable implementation, added
because the real Pinata upload surface (`sdk.upload.public.file`) was
independently verified against the installed `pinata@2.x` SDK's own
`.d.ts` (not invented), and covered by
`content-protection-pinata-storage-adapter.test.ts` against a **fake**
`PinataProviderClient` -- unit-level evidence only; no `PINATA_JWT` is
configured in this environment, so no live-provider verification was
possible or attempted (see the final report's "Provider behavior" section
for this distinction stated explicitly, mirroring
`access-grant-pinata-live.test.ts`'s precedent for Slice 1).

---

## No ungoverned decryption path

`ContentProtectionService` exposes exactly `protectResource` and
`getProtectedResource` -- no decrypt method, no `unwrapKey` call anywhere
in `service.ts`. `aead.ts`'s `decryptContent` and
`key-wrapping-port.ts`'s `unwrapKey` remain available as low-level
primitives (required for this slice's own tests, and for a future,
separately-gated `KeyBroker`), but neither is reachable from any
application-level orchestration this slice wires up.

---

## A pre-existing typing defect this slice's code exposed and fixed

`types/node-shims.d.ts` declared a local `interface Buffer { toString(...);
[index: number]: number; readonly length: number }` nested inside
`declare module 'crypto' { ... }`. Because TypeScript merges all
`declare module 'crypto'` blocks (across every `.d.ts` file compiled into
the program) into one synthetic module namespace, this stub shadowed the
real, full `@types/node`-provided `Buffer` type for any unqualified
`Buffer` reference resolved from within that merged namespace -- including
`randomBytes(size): Buffer` and `Hash.digest(): Buffer` as declared by
`@types/node` itself, once merged with this repository's own shim.

No code in this repository before this slice ever exposed a `Buffer`-typed
value across a public function signature from a `'crypto'`/`'node:crypto'`
import (every prior caller immediately reduced a digest to a hex/base64
string), so this latent defect never manifested. `aead.ts` is the first
module that legitimately needs typed `Buffer` values (DEKs, nonces,
ciphertext, auth tags) flowing through its own function signatures, which
surfaced it immediately as a compile error.

**Fix**: removed the shadowing `interface Buffer { ... }` block from
`types/node-shims.d.ts` (4 lines). `randomUUID`/`randomBytes`/`createHash`/
`createHmac`'s own declared signatures are unchanged; their `Buffer`
references now correctly resolve to the real, full `@types/node` type. This
is strictly additive correctness -- every prior caller's usage (all of
which only ever called `.toString()`/`.digest('hex')`, methods the real
`Buffer` type also has) continues to compile identically; confirmed by a
full `npm run build` + `npm run lint` + `npm run test:root` +
`npm run test:workspaces` pass (see final report for exact totals) with no
other file affected.

---

## Security tests

See `src/enterprise/__tests__/content-protection-crypto.test.ts` (Tests
A-G + `KeyWrappingPort` structural safeguards),
`content-protection-service.test.ts` (Tests H-N + tenant isolation +
sovereign-binding-gate behavior), `content-protection-store-contract.test.ts`
(persistence contract, both `in-memory` and `sqlite`, including Test K),
`content-protection-boundary.test.ts` (Section 22's copy test, Section 23's
plaintext-escape boundary test), and
`content-protection-pinata-storage-adapter.test.ts` (unit-level Pinata
adapter evidence). Full list and results in the final report.

---

## Deferred to Slice 3

- `ExecutionGrant` asset binding, `KeyBroker` authorization-gated
  decryption, production KMS/HSM integration, player, media streaming,
  offline licenses, watermarking, fingerprinting, piracy monitoring,
  automatic royalty settlement, Kill Switch claims, derivative detection --
  all explicitly out of scope per the Slice 2 task description.
- Full `composition-root.ts`/HTTP-adapter/module-registry wiring (a new
  `AocEnterprise.contentProtection`, `/api/protected-resources/*` routes)
  -- mirrors Slice 1's own precedent of shipping the durable module and its
  one authoritative orchestration path fully usable in-process (proven by
  this slice's own test suite) without yet wiring public HTTP surface.
  `packages/pinata-adapter`'s new `uploadCiphertext` capability is
  correspondingly not yet exercised by any HTTP route.
- A real, Protocol-backed `SovereignAssetBindingPort` implementation --
  blocked on Protocol shipping `SovereignAssetId`/`SovereignManifest`/
  `contentDigest`/`resolveSovereignAsset()`/`verifySovereignManifest()`;
  this slice's own verification logic is ready and tested against a
  test-only fake in the meantime.
