# Soberanía runtime artifacts — consumption evidence (FRONTERA-SOBE-PILOT-01A)

**Status: NOT PUBLISHED.** No registry publication, no tag, no release, no deployment. This document
records what was verified; it authorizes nothing. No Frontera source consumes these artifacts and none
is installed into Frontera's dependency graph.

> **Historical record (01A, source `1112c63`).** FRONTERA-SOBE-PILOT-01C0 re-pinned the artifacts to
> Soberanía `e85cf1b` (only `@aoc-runtime/authorization-runtime` changed) and installed them as
> production dependencies. The current evidence is
> [`SOBERANIA_RUNTIME_DEPENDENCY_CLOSURE_EVIDENCE_01C0.md`](SOBERANIA_RUNTIME_DEPENDENCY_CLOSURE_EVIDENCE_01C0.md);
> this document is kept unchanged below as the record of what 01A verified.

## Source and packaging

| Field | Value |
| --- | --- |
| Source repository | `Republika-Network/Soberania_Protocol` |
| Source commit | `1112c63d93875400aeae8e01d85f3c8543be51d4` (tree `ae1f68ef9169620dca7c50c53c20ad7614e9dc69`) |
| Checkout | fresh clone, clean before and after |
| Build | `npm ci`, `npm run build`: the committed `dist/` of every package reproduced byte for byte |
| Pack | `npm pack --pack-destination <dir> ./<package dir>`; a second pack was byte-identical for all seven |
| Toolchain | Node v22.23.1, npm 10.9.8 |
| Source modified | no |

## Artifacts

| Package | Role | Bytes | Files | SHA-256 |
| --- | --- | --- | --- | --- |
| `@aoc-runtime/authorization-runtime` | runtime | 16,755 | 7 | `02d40c4c3377b06a2f27dfb31d4c28848fef424ce4bafee680d866f7b198ce4f` |
| `@aoc-runtime/capability-runtime` | runtime | 6,158 | 7 | `c4b3a7ee9fb5bdebf37e5f7ad26915c5fbb8e2aff8f17eb5f5995c4c2942e4b5` |
| `@aoc-runtime/consent-runtime` | runtime | 8,639 | 7 | `16291bc15a7d21e384bba5a857fc160b94454dac6245aee3bf402606df6aaccc` |
| `@aoc-runtime/crypto` | runtime | 23,070 | 25 | `8fc44bee0e80cbd6afeaf07149e0decbad1212ba234c6383a30663e937df3f3a` |
| `@aoc-runtime/governance-runtime` | runtime | 20,683 | 7 | `90397c96326b5b5c663e31d4fa622a99b6ec50162e129763354fa31dc922672b` |
| `@aoc-runtime/provider-interfaces` | declarations | 4,670 | 7 | `48aebc4adda787adaf55828ffd7e5daf8e225d1e9b8e67f24e344ec9a1e0c4f5` |
| `@aoc-runtime/shared-types` | declarations | 9,438 | 11 | `587b900de77470ea400099e7ed71d43e50c423832f9a0e6de959ac0ae2efe28f` |

SHA-512, npm integrity and the full file inventory of each artifact are in
`soberania-runtime-consumer.lock.json`.

## Closure

- **Runtime** (verified from the compiled `require` calls): authorization-runtime requires nothing;
  governance-runtime and consent-runtime require `@aoc-runtime/crypto`; capability-runtime requires
  nothing; crypto requires `@aoc/protocol/canonical` and `node:crypto`. The plain-Node scenario loaded
  exactly these five packages and, from `@aoc/protocol`, only `dist/canonical/`.
- **Declarations**: provider-interfaces and shared-types are needed for types and are never loaded.
  authorization-runtime's declarations also import the excluded `@aoc-runtime/audit-runtime` and
  `@aoc-runtime/trust-registry-runtime`: a strict consumer type-checks with `skipLibCheck: true`
  (Frontera's setting) with those types as `any` — an audit argument of the wrong type is not rejected —
  and fails with exactly those two unresolved imports without it.
- **Excluded**: root `aoc-runtime`, trust registry, audit wrapper, `@aoc/enterprise`, Portable
  Cognition, vault runtime, PMFreak adapter.

## Content review

Every artifact contains its `dist/`, sources and build metadata (`tsconfig.json`,
`tsconfig.tsbuildinfo`); crypto also contains its unit tests. A scan of all extracted files found no
environment or key files, no private keys or token patterns, no absolute local paths and no
security-evidence identifiers. No export names an HMAC, payout, KYC, federation, trust-registry,
Portable Cognition, hosted or vault surface. Present but not approved for pilot use: crypto
`encryptObject`/`decryptObject`; governance-runtime's bootstrap-brief and resource-accounting helpers.

## Plain-Node consumption (real runtime stages)

Run from a temporary directory containing only the extracted artifacts and the installed
`@aoc/protocol` 0.2.0-rc.3, with `NODE_PATH` and `NODE_OPTIONS` cleared, using the real
`AuthorizationRuntime`, `GovernanceRuntime`, `CapabilityRuntime` and `ConsentRuntime`, in-memory
providers, keys generated for the run, one ISO-8601 server time passed as both `at` and `now`. The audit
finalizer is a pass-through (Soberanía's lives in the excluded `@aoc/enterprise` and decides nothing).

| Case | Result |
| --- | --- |
| Valid capability, owner-signed delegated consent with delegate countersignature, confirmed owner, allow policy | **allow** |
| Correctly signed consent from a non-owner | deny (consent) |
| Unsigned; signed with another trusted key; altered after signing; delegated without countersignature | deny (consent) |
| Expired capability | deny (capability) |
| Expired consent; revoked consent | deny (consent) |
| Ownership provider throws; ownership unknown | deny (consent) |
| Policy, capability or consent provider throws | `evaluate()` rejects — never an allow |
| `at` as a `Date`; grant `issuedAt` as an epoch number | deny (consent) |
| malformed `now`; capability `expiresAt` as a `Date` | deny (capability) |
| No matching governance rule; a governance deny rule | deny (governance) |
| Sibling namespace; `..` traversal | deny (capability) |
| Federated authority without a verifier | deny (governance) |

## Integrity and boundary checks (mutation-verified)

| Mutation | Caught by |
| --- | --- |
| An excluded package's tarball, or the root `aoc-runtime` tarball, added to `vendor/soberania-runtime/` | test and `check:soberania-runtime-lock` |
| One byte of an artifact flipped; an artifact deleted | test and check |
| A Frontera source file importing `@aoc-runtime/crypto` | test and check |
| An excluded package listed in the lock | test and check |

Also asserted: the lock lists exactly the approved packages with their roles; every artifact's name,
version, single `"."` export, packed entry points and runtime requires; the canonical Protocol subpath
is required only by crypto and is still not an allowed source import; no Frontera manifest or lockfile
entry names a runtime package.

## Validation (final tree, run sequentially)

| Check | Result |
| --- | --- |
| Isolated Protocol tarball validation (now copying `vendor/soberania-runtime/*.tgz`) | every step passes, including its embedded full test run |
| `typecheck`, `build`, `lint` | pass |
| `npm test` (root) | 13,425 tests, 0 failed (11 skipped, 7 todo — pre-existing); every workspace suite passes |
| `legal:check`, `check:release-coherence`, `validate:publishability`, `check:clean-room-consumer` | pass |
| `check:protocol-compatibility-lock`, `verify-tarball-against-lock`, canonicalization regression | pass |
| `check:soberania-runtime-lock` | pass (7 artifacts) |
| `check:protocol-consumption`, `check:protocol-contract-adoption`, `check:aoc-boundaries`, `check:release-integrity` | pass |
| `qualify:pilot` | 181 passed, 0 failed |
| DEMO-01 evidence capture test | 4 passed |

## Unchanged

No Kernel, Host, authentication, payment, evidence or deployment change. `protocol-consumer.lock.json`,
the Protocol tarballs and `package-lock.json` are unchanged.
