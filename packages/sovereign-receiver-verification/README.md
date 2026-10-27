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

`verified` means the bundle passed every check below. It grants nothing: no access decision, no
execution capability and no Host request. Every result reports `authorization`, `revocation` and
`freshness` as `not_evaluated`.

## What the strict profile checks

All cryptography and structure come from the vendored `@aoc/protocol@0.2.0-rc.3`
(`/identity`, `/manifest`, `/portability`, `/interoperability`). This package adds the strict
receiver rules around them:

1. **Strict parsing.** The bundle text must parse with `parseSovereigntyPortabilityBundle`, and it must
   be byte-identical to its canonical serialization. Pretty-printed, reordered or padded text is rejected.
2. **Identity.** Every artifact is about the bundle subject, and that subject matches
   `expectedSovereignAssetId` when one is given.
3. **Signed only.** Every manifest and claim must be signed, and at least one signed manifest is
   required. Standings travel unsigned, so a bundle carrying any is rejected.
4. **Exact compatibility.** The receiver's consumer support must assess as `compatible`.
   `partially-compatible` is rejected, so a receiver never consumes semantics it did not declare.
5. **Manifests.** `verifySovereignManifest` must report the structure, digest and signature as valid
   and the issuer binding as `verified`. Protocol's own `valid` is not relied on, because it stays
   true when the binding was `not_performed`.
6. **Content.** When the current (highest-version) manifest declares a content identity, the bytes
   are required and must match. Bytes supplied with nothing to check them against are rejected.
7. **Claims.** `verifySignedSovereignClaim` must report the structure, digest and signature as valid
   and the binding as `verified` for the claim's own signed issuer.

Issuer binding follows Protocol rc.3 (the SOBE-SEC-01 fixes). A key binds only when it produced the
signature, its key id derives from that key, and the resolver vouches for it for the issuer the
signed artifact names. `expectedIssuer` can only narrow that issuer. A registrant that is a principal
reference needs `expectedIssuer`; without it the binding is not performed and the bundle is rejected.

Options are read once into a private snapshot and unknown options are refused. Resolver failures,
hostile getters and unexpected exceptions all fail closed.

## Not covered

- Revocation, key validity windows and freshness (no clock is read).
- Claims embedded inside a manifest. The manifest signature covers them, but they are not reported as
  separately issuer-verified claims.
- Content of manifest versions other than the current one.
- PUSH execution, enforcement and content access (later work).
