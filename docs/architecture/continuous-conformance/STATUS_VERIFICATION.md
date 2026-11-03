# Public Status Verification (PROPOSED — no endpoint is created by this mission)

The question a verifying enterprise asks:

> *Is this exact platform integration currently conformant with the specified Soberanía profile?*

The answer is a signed `ConformanceStatusAssertionV1` ([INTEGRATION_CONTRACTS.md §5](INTEGRATION_CONTRACTS.md#5-status-assertion-d6--verifiers)).
The design reuses the FV signed-status model (`SignedSovereignStatusV1`: closed schema, `purpose` domain
field, `sequence`, `previousStatusDigest`, `issuedAt ≤ t < validUntil`) and its receiver-side
high-water-mark logic (`establishStatusHistory`: rollback, conflict, clock-rollback detection).

## 1. Two verification modes

| Mode | How | Replay protection | Max staleness |
|---|---|---|---|
| **Online (recommended for decisions)** | Verifier POSTs `{credentialId, nonce, expect}`; registry signs a fresh assertion echoing `requestNonce` | Nonce echo (witness challenge pattern) | 0 (bounded by network latency) |
| **Stapled / offline** | Platform or verifier presents the latest stapled assertion | `sequence` + high-water mark + `validUntil` | ≤ 15 min (proposed `validUntil - issuedAt`) |

## 2. Verifier algorithm (normative proposal)

1. Parse exact canonical text; reject unknown fields (closed schema).
2. Check `schema`, `purpose`.
3. Resolve `signature.keyId` against the **pinned** Republika status-issuer key set (distributed out of
   band; `/keys` is a convenience, not a trust root). Reject keys embedded in the assertion.
4. Verify Ed25519 over `frontera:conformance-status:v1\n ‖ canonical(payload)`.
5. Check bindings against what the verifier expects: `credentialId`, `subject.platformId`,
   `subject.integrationId`, `subject.integrationDigest`, `profile.id/version`. Any mismatch → **not
   conformant** (credential substitution / version / subject mismatch).
6. Check `issuedAt ≤ now < validUntil` with the verifier's trusted clock; `validUntil - issuedAt ≤ 15 min`.
7. Online mode: `requestNonce` equals the nonce sent.
8. Update local high-water mark per `credentialId`: lower `sequence` → `ROLLBACK_DETECTED`; equal
   sequence with different digest → `CONFLICT_DETECTED` (latched); next sequence must link via
   `previousAssertionDigest` or be marked `CONTINUITY_UNPROVEN`.
9. Conformant **iff** `state === 'ACTIVE'` **and** `evidenceFreshness.freshUntil > now` **and** the operation
   the verifier cares about is in `scope.coveredOperations` and not in `declaredExclusions`.

Any failure → treat as *not currently conformant*. There is no "probably active" outcome.

## 3. Threat-to-control mapping

| Threat | Control |
|---|---|
| Old ACTIVE response | Short `validUntil`; online nonce; high-water mark |
| Cached state after suspension | Registry never issues ACTIVE for a superseded `stateVersion`; HTTP `Cache-Control: max-age` ≤ remaining validity; `no-store` in online mode |
| Credential substitution | Mandatory `expect` binding; registry returns signed mismatch result |
| Version mismatch | `integrationDigest`, `profile.version`, `sdk.version` bound and signed |
| Subject mismatch | `platformId` + `organizationId` + `integrationId` bound |
| Replay | Nonce (online); `sequence` + `previousAssertionDigest` (offline) |
| Forged issuer status | Pinned issuer keys; domain-separated signature; keyId derived from key |
| Stale monitoring results | `evidenceFreshness.freshUntil` must be in the future even when `state = ACTIVE` |
| Registry compromise | See [THREAT_MODEL.md](THREAT_MODEL.md): signing key in a separate process (CORE-02 pattern), transition hash chain anchored externally, independent witness of registry head |

## 4. Trust assumptions (explicit)

1. The verifier pins the Republika status-issuer public keys out of band.
2. The verifier has a trustworthy clock (± 5 s).
3. The status-signing key is held outside the registry database's restore domain.
4. "ACTIVE" means: *as of `issuedAt`, Republika's engine had accepted corroborated evidence meeting the
   profile and had not accepted a confirmed critical violation.* It is not a certification, warranty or
   audit opinion, and it covers only the listed operations of the listed integration digest.
5. Chain anchors prove a transition digest existed by a ledger time. They do **not** prove current state.

## 5. API requirements (for RN-CONFORM-03)

* Read-only; no authentication required for status; rate-limited.
* Subject privacy: public response omits evidence packages and validator identities beyond operator ids
  ([CC-D-13](DECISION_REGISTER.md#cc-d-13)).
* Never returns an unsigned status. Errors are signed `UNAVAILABLE` assertions; clients treat them as not
  conformant.
* Verifier library published alongside, mirroring `verifySovereignStatus` (never throws; one reason code
  per rejection).
