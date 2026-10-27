# @aoc-enterprise/sovereign-receiver-verification

Private. Strict receiver-side verification of a received Soberanía sovereign asset (RSDK-01).

```ts
import { verifyReceivedSovereignAsset } from '@aoc-enterprise/sovereign-receiver-verification';

const result = await verifyReceivedSovereignAsset(bundleText, {
  verificationKeyResolver, // required: binds each signed issuer to its trusted key
  consumerSupport,         // required: what this receiver can consume
  expectedSovereignAssetId, // optional: the subject must be exactly this asset
  expectedIssuer,           // optional: narrows (never replaces) the signed registrant
  contentBytes,             // required when the current manifest commits to content
});
```

`result.outcome` is `verified` or `rejected`. A rejection carries only codes from
`RECEIVER_VERIFICATION_REJECTION_REASONS`. The function never throws.

## Verification is not authorization

This package verifies authenticity and representation consistency only. `verified` means the
bundle passed every check below. It grants nothing: no access decision, no execution capability,
no content release and no Host request. Every result reports `authorization`, `revocation` and
`freshness` as `not_evaluated`. Whether an asset may be used, served or acted on, including a
`withdrawn` or `disputed` one, is decided by trusted policy enforcement, not here.

## What the strict profile checks

All cryptography and structure come from the vendored `@aoc/protocol@0.2.0-rc.3`
(`/identity`, `/manifest`, `/portability`, `/interoperability`). This package adds the strict
receiver rules around them:

1. **Strict parsing.** The bundle text must parse with `parseSovereigntyPortabilityBundle`, and it must
   be byte-identical to its canonical serialization. Pretty-printed, reordered or padded text is rejected.
2. **Identity.** Every artifact is about the bundle subject, and that subject matches
   `expectedSovereignAssetId` when one is given.
3. **Signed only.** Every manifest and claim must be signed, and at least one signed manifest is
   required.
4. **Registrant continuity.** Every signed manifest version must name the same registrant, compared by
   canonical identity: a string registrant, or a principal reference's `id`. That is the identity
   Protocol's issuer binding resolves. Display names, `kind`, `source` and metadata are not identity.
   A bundle whose versions name different registrants is rejected with `REGISTRANT_DISCONTINUITY`
   before any key is resolved. This holds even when every signature is valid and every issuer is
   trusted: rc.3 manifests do not chain to one another and carry no transfer of authority, so a
   newer version from another issuer is never taken as this asset's current record.
5. **Current manifest.** The current manifest is the highest `manifestVersion` *in this bundle*.
   One that records its own state as `superseded` contradicts the bundle that carries it and is
   rejected with `CURRENT_MANIFEST_SUPERSEDED`.
6. **Exact compatibility.** The receiver's consumer support must assess as `compatible`.
   `partially-compatible` is rejected, so a receiver never consumes semantics it did not declare.
7. **Manifests.** `verifySovereignManifest` must report the structure, digest and signature as valid
   and the issuer binding as `verified`. Protocol's own `valid` is not relied on, because it stays
   true when the binding was `not_performed`.
8. **Content.** When the current manifest declares a content identity, the bytes are required and
   must match. Bytes supplied with nothing to check them against are rejected.
9. **Claims.** `verifySignedSovereignClaim` must report the structure, digest and signature as valid
   and the binding as `verified` for the claim's own signed issuer.

## Issuers

Issuer binding follows Protocol rc.3 (the SOBE-SEC-01 fixes). A key binds only when it produced the
signature, its key id derives from that key, and the resolver vouches for it for the issuer the
signed artifact names.

- **Verified issuer vs caller-provided issuer.** `currentIssuer` and each `manifests[].issuer` are
  the signed registrant, bound to a trusted key. They never come from `expectedIssuer`, which can only
  narrow the check: a different value is rejected (`ISSUER_BINDING_MISMATCH`), and it cannot repair a
  bundle with discontinuous registrants. A registrant that is a principal reference needs
  `expectedIssuer`; without it the binding is not performed and the bundle is rejected.
- **Claims from other trusted issuers.** `expectedIssuer` applies to manifests only. A separately
  signed claim is verified against its own signed issuer, so a bundle may carry verified claims from
  any issuer the resolver trusts. Each one is reported with its `claims[].issuer`; a receiver that
  only accepts claims from the registrant must filter on that field.

## Lifecycle state

Each verified manifest reports the `state` it records (`active`, `disputed`, `superseded` or
`withdrawn`), and `currentState` is the state of the current manifest.

- `withdrawn` is authentic history. It verifies, and is reported as `withdrawn`, never as active.
- `superseded` is accepted on earlier versions and rejected on the current one (see above).
- State is reported, not enforced. It is the signer's assertion about the record, not an
  eligibility decision.

## Standings

Standings are unsigned, carry no issuer, and no signature in the bundle covers them. They are
accepted only when they pass Protocol's own standing validation and the receiver's consumer support
declares both the `standing` artifact kind and each status present. The result reports
`standings: 'none' | 'present_unverified'`.

A standing is never part of `claims`, never changes manifest or claim verification, and grants
nothing. A `Contested`, `Verified` or `Revoked` standing does not establish a dispute outcome or any
authoritative status. Anyone who handles the bundle can add or remove one.

## Not covered

- **Freshness.** `currentManifestVersion` is only the highest version provided
  (`currentManifestBasis: 'highest_version_in_bundle'`). A bundle that omits newer versions cannot
  be detected. No clock is read.
- **Revocation.** Revocation and key validity windows are not checked.
- **Embedded claims.** Claims embedded inside a manifest are covered by the manifest signature, but
  they are not reported as separately issuer-verified claims.
- **Older content.** Content of manifest versions other than the current one is not checked.
- **Later work.** PUSH execution, enforcement and content access.
