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

## Options and content bytes

Options are read once into a private snapshot before anything else runs. Changing the options
object, or the bytes it pointed at, after the call starts has no effect.

- **Recognized options are never dropped.** They are found wherever they are defined on the options
  object or its prototypes, up to `Object.prototype`. That covers own or inherited properties,
  enumerable or not, and data properties or getters. Each is read exactly once, so a getter cannot
  answer differently later. A getter or proxy trap that throws rejects the call.
- **Unrecognized options are refused** (`INVALID_OPTIONS`) rather than ignored, wherever they appear
  in that chain, enumerable or not. The one exception is a class prototype's `constructor`. Class
  instances therefore work only when they expose nothing but recognized options (`#private` fields
  are fine).
- **`Object.prototype` is not a configuration source.** A recognized option that reads as defined
  without appearing in the inspected chain is refused. Such a value would come from a polluted
  global prototype, or from a proxy hiding its keys.
- **`contentBytes` must be a genuine `Uint8Array`**, checked by the intrinsic typed-array brand.
  Subclasses such as `Buffer` are accepted; proxies, look-alike objects and other typed arrays are
  refused. The bytes are copied into a fresh intrinsic buffer without consulting the caller's
  species constructor. The snapshot therefore never aliases memory the caller can still change.

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

## Document-use eligibility (FV-P2, opt-in)

`verifyDocumentUseEligibility` is a separate, additive entry point for assets declared under the
Soberanía `soberania.document-use/1` profile (PROPOSED). `verifyReceivedSovereignAsset`, its options,
its reasons and its result are unchanged; existing callers (RSDK-02B) are not affected.

```ts
import { verifyDocumentUseEligibility } from '@aoc-enterprise/sovereign-receiver-verification';

const result = await verifyDocumentUseEligibility(bundleText, {
  verificationKeyResolver,  // required
  expectedSovereignAssetId, // required here (optional in RSDK-01)
  expectedIssuer,           // optional, passed to RSDK-01
  contentBytes,             // required: a document asset must commit to its bytes
});
```

It first runs RSDK-01 with the profile's own, fixed compatibility declaration (`Authorship` claims,
the four licensing declaration concepts and the profile's four action concepts; nothing else). Only a
`verified` bundle is then checked against the eligibility preconditions RSDK-01 does not cover:

| Precondition | Refusal |
|---|---|
| The caller names the expected asset | `EXPECTED_ASSET_REQUIRED` |
| The current manifest is `active` and commits to content | `MANIFEST_STATE_NOT_ACTIVE`, `CONTENT_IDENTITY_NOT_DECLARED` |
| The bundle carries exactly one claim, and it is a terms claim | `TERMS_MISSING`, `TERMS_AMBIGUOUS`, `TERMS_UNEXPECTED_CLAIM` |
| The terms pass Protocol's `validateLicenseTermsClaim` | `TERMS_STRUCTURE_INVALID` |
| The terms are about the expected asset | `TERMS_SUBJECT_MISMATCH` |
| The terms issuer is the verified registrant, re-verified with Protocol's expected-issuer binding | `TERMS_ISSUER_NOT_REGISTRANT`, `KEY_RESOLVER_FAILED` |
| Every rule names a concept from the profile's table | `TERMS_CONCEPT_UNSUPPORTED` |

`result.outcome` is `eligible_for_evaluation` or `ineligible`. An ineligible result names its `stage`
(`options`, `artifact_verification` or `eligibility`) and carries only codes from
`DOCUMENT_USE_INELIGIBILITY_REASONS`, which contains every RSDK-01 reason. Options are read once, as
plain own data properties only (accessors, inherited and unknown keys are refused), and the same
snapshot is handed to RSDK-01. The caller cannot supply `consumerSupport`.

**Eligible is not allowed.** `eligible_for_evaluation` means the terms are authentic, authoritative,
well-formed and unambiguous, and returns them as plain data for a later evaluator. It is not a policy
decision: `policyEvaluation`, `authorization`, `revocation`, `freshness`, `temporalValidity` and
`audience` are all `not_evaluated`. Expired or not-yet-effective terms are still eligible: their
instants are reported, never compared with a clock. Rule semantics (ALLOWED / DENIED / WITHHELD),
approval evidence, audience matching, replay of older terms and revocation are later work.

Protocol access: this entry point needs `@aoc/protocol/licensing`, added to this package's scoped
allowance for FV-P2 (see `docs/integration/PROTOCOL_PACKAGE_CONSUMPTION.md`).

## Document-use policy evaluation (FV-P3)

`evaluateDocumentUsePolicy` applies the `soberania.document-use/1` rule semantics to an eligible result
and returns `ALLOWED`, `DENIED` or `WITHHELD` with exactly one reason from
`DOCUMENT_USE_POLICY_REASONS`. It is synchronous and pure. It reads no clock, environment, network,
storage or credentials, and it imports nothing from Protocol.

```ts
import { evaluateDocumentUsePolicy, verifyDocumentUseEligibility } from '@aoc-enterprise/sovereign-receiver-verification';

const eligibility = await verifyDocumentUseEligibility(bundleText, verificationOptions);
const result = evaluateDocumentUsePolicy(
  eligibility,                                       // only a result issued by FV-P2 in this process
  { action: 'soberania.document:export' },           // the requester's input: the action, nothing else
  {                                                  // supplied by the host, never by the requester
    receiverPrincipal,                               // this platform's own identity
    evaluationTime,                                  // canonical UTC timestamp from the host's trusted clock
    expectedSovereignAssetId,
    policyReference: { claimId, claimDigest },       // the terms the host expects to be evaluated
  },
);
```

Evaluation, in order. Any failure is `DENIED`:

1. **Inputs.** The eligibility must be an object `verifyDocumentUseEligibility` returned in this process
   (deeply frozen, held in a private `WeakSet`). Copies and fabricated objects are refused. The request
   and the context are read once, as plain own data properties: accessors, inherited fields and unknown
   keys are refused. The asset and the policy reference must match the eligible ones exactly.
2. **Time.** The terms apply from `effectiveAt` (inclusive) until `expiresAt` (exclusive). Bounds are
   compared exactly, to the nanosecond, with no grace period, and absent bounds are absent.
3. **Audience.** A `Principal` audience must equal `receiverPrincipal` exactly. `Custom` is not
   interpreted, so it is denied. `Public` (founder decision, FV-P3.1) means the terms are addressed to
   any receiver. It does **not** mean the content is publicly accessible, and it does not authorize any
   operation. A Public-audience receiver is still subject to every rule below, to the time bounds, to
   the asset binding and to eligibility, and still needs a valid `receiverPrincipal`. No audience can
   turn a Restriction into a Permission.
4. **Rules.** Every rule must name a profile concept and carry an effect that has a meaning there:
   Permission or Restriction over an action, Obligation over the obligated approval action.
   - A Restriction over the action → `DENIED`.
   - No Permission → `DENIED`.
   - `modify-protected-terms` with an owner-approval obligation → `WITHHELD`.
   - Otherwise → `ALLOWED`.

**No approval field exists.** The approval evidence format is not defined, so `WITHHELD` can never
become `ALLOWED` here. **Evaluation is not authorization**: a decision reports `authorization`,
`revocation` and `freshness` as `not_evaluated` and `execution` as `not_performed`. It carries no
capability, no document content and no secret. Handoff for later signed evidence:
`docs/integration/FV_DOCUMENT_POLICY_DECISION_HANDOFF.md`.

## Signed sovereign status (FV-P4B)

`verifySovereignStatus` verifies one `soberania.sovereign-status/1` artifact: a statement, signed by the
asset's registrant, that the asset is `active` or `withdrawn`, which manifest and which terms are
current, and where the statement sits in the registrant's sequence. The profile is Soberanía's
`docs/protocol/profiles/SOVEREIGN_STATUS_PROFILE.md` (PROPOSED).

```ts
import { verifySovereignStatus } from '@aoc-enterprise/sovereign-receiver-verification';

const status = await verifySovereignStatus(signedStatusText, {   // aoc-canonical-json/1 text
  verificationKeyResolver,                 // the same trusted resolver RSDK-01 uses
  expectedSovereignAssetId,                // from the host's own verification of the asset
  expectedRegistrant,                      // RSDK-01 currentIssuer
  expectedManifestDigest,                  // the verified current manifest's digest
  expectedTerms: { claimId, claimDigest }, // optional: the terms the host is about to rely on
  evaluationTime,                          // canonical UTC timestamp from the host's trusted clock
});
```

`authentic_authorized` means exactly this, and nothing more:

1. **Form.** Exact `schemaVersion` and `purpose`, exact keys at every level, typed values, a safe-integer
   `sequence` ≥ 1 with `previousStatusDigest` `null` exactly at 1, `withdrawn` only with `currentTerms:
   null`, and the text is the one `aoc-canonical-json/1` serialization (no duplicate keys, whitespace or
   alternative spellings). Protocol's signature carries no domain prefix, so `schemaVersion`, `purpose`
   and the closed schema are what keep a status from being read as a manifest or a claim.
2. **Integrity.** `verifySovereignSignature` (rc.3) recomputes the payload hash and checks the Ed25519
   signature. `statusDigest` is that hash.
3. **Authority.** The status issuer is `expectedRegistrant`, and the resolver, asked once and only for
   that registrant, binds the signing key with the same invariants as Protocol's SOBE-SEC-01 issuer
   binding. One deliberate difference: a descriptor carrying `publicKeyJwk` is refused, because
   Protocol's JWK comparison is not public. There is no delegation and no key rotation.
4. **Binding.** The asset and the manifest digest, and the terms when `expectedTerms` is given, equal the
   host's expected values. A status naming no current terms does not match expected terms.
5. **Window.** `issuedAt ≤ evaluationTime < validUntil`, exactly to the nanosecond, with no grace, and the
   window is at most seven days. That bound limits the artifact; it is not a freshness policy.

**A verified status may already be stale.** Without a trusted history the verifier cannot know whether a
newer status revoked or superseded the one presented, so a correctly signed status keeps verifying until
its `validUntil`. Every result reports `freshness` and `revocationCurrentness` as `not_evaluated`,
`authorization` as `not_evaluated` and `execution` as `not_performed`; `active` is an assertion, not a
permit. Replay detection against a high-water mark is FV-P4C. Rejections carry exactly one reason from
`SOVEREIGN_STATUS_REJECTION_REASONS`. The verifier reads no clock, environment, network or storage, and
never throws.

## Document-use freshness and anti-replay (FV-P4C-1)

`checkDocumentUseFreshness` decides whether an FV-P3 decision may stand, given a signed status and this
receiver's own trusted history of that asset's statuses. It never raises a decision: `ALLOWED` stays
`ALLOWED` and `WITHHELD` stays `WITHHELD` only when the verdict is `FRESH`, and everything else becomes
`DENIED`. It is not authorization: every result reports `authorization: 'not_evaluated'` and
`execution: 'not_performed'`, and `WITHHELD` is never executable.

```ts
import {
  checkDocumentUseFreshness,
  createInMemoryStatusHighWaterMarkStore,
  establishStatusHistory,
} from '@aoc-enterprise/sovereign-receiver-verification';

const historyStore = createInMemoryStatusHighWaterMarkStore();   // process-local reference store

// Out of band, once, by the host: anchor the history with a status obtained through a channel it
// trusts to be current. Never reached from a request.
await establishStatusHistory(trustedStatusText, {
  verificationKeyResolver, historyStore, expectedSovereignAssetId, expectedRegistrant, expectedManifestDigest, evaluationTime,
});

const decision = evaluateDocumentUsePolicy(eligibility, { action }, policyContext);   // FV-P3, this process
const freshness = await checkDocumentUseFreshness(decision, signedStatusText, {
  verificationKeyResolver,
  evaluationTime,             // must equal the decision's evaluationTime
  operationId,                // the host's identifier for the operation, echoed for evidence
  maxStatusAgeSeconds,        // per action, 1 s up to DOCUMENT_USE_FRESHNESS_CEILINGS
  historyStore,
});
```

Checks, in order, and the first that fails decides:

1. **Provenance.** The decision must have been issued by `evaluateDocumentUsePolicy` in this process
   over an eligibility issued by FV-P2. Both are held in private `WeakMap`s. Copies, deserialized
   decisions and look-alikes are `POLICY_PROVENANCE_INVALID`.
2. **Context.** It is read once, as plain own data. The instant must equal the decision's. Each action's
   maximum age is an integer from 1 second to its ceiling: 24 h for read, 15 min for export and for
   modify. A host may be stricter, never looser, and nothing is defaulted.
3. **Status.** The gate verifies the artifact itself with `verifySovereignStatus`. The asset, registrant
   and manifest come from the eligibility, never from the status or the caller, so a result object
   claiming `authentic_authorized` is just malformed input.
4. **History.** The `(asset, registrant)` history must already be established; otherwise the verdict is
   `HISTORY_UNINITIALIZED`, for every action. Against the stored high-water mark:

   | Presented status | Effect on the mark | Verdict |
   |---|---|---|
   | lower sequence | none | `ROLLBACK_DETECTED` |
   | same sequence, same digest | none | continues |
   | same sequence, other digest | conflict latched | `CONFLICT_DETECTED` |
   | next sequence that does not link to the head, reactivates a withdrawal, makes retired terms current, or is issued earlier than the head | conflict latched | `CONFLICT_DETECTED` |
   | next sequence, linked | advances | continues |
   | sequence beyond the next (gap) | advances, continuity unproven (sticky) | `CONTINUITY_UNPROVEN` |

   - **Clock rollback:** a trusted instant earlier than any accepted `issuedAt` is
     `CLOCK_ROLLBACK_DETECTED`.
   - **Writes:** the mark changes only through the store's atomic `compareAndSet`, against the
     revision it was computed from. A lost race is recomputed from the winner's state.
   - **Clearing latches:** a latched conflict or a gap is cleared only by re-anchoring with
     `establishStatusHistory(..., { reanchor: true })`. A re-anchor never lowers the sequence, reopens a
     withdrawal or revives retired terms.
5. **Meaning.** The presented status is now the latest this receiver knows:
   - `withdrawn` → `WITHDRAWN`;
   - no current terms → `REVOKED`;
   - other terms than the evaluated ones → `SUPERSEDED`;
   - older than the action's maximum age → `STALE` (an age exactly equal to the limit is still fresh);
   - otherwise → `FRESH`.

**Freshness is measured at the decision's instant.** The gate accepts no second instant: age, window and clock checks all use the FV-P3 decision's `evaluationTime`. It does not show that a status is fresh at the time of some later operation, so a decision must be evaluated anew for each operation (FV-P5 will bind that to the operation and a trusted clock). A sequence gap stays refused until a trusted re-anchor, which can cost availability; there is no bypass.

**What it cannot know.** The mark records only what this receiver accepted. A replay of a status older
than one it saw is detected. A revocation that never reached it is not, and nothing here learns of
statuses from other receivers. The in-memory store protects one process while it lives: a restart, a
second instance or a worker starts uninitialized and refuses. It is not persistent rollback protection,
and a rollback of the whole store cannot be detected. Persistent, anchored storage is FV-P4C-2. Evidence
fields for ASSURE: `docs/integration/FV_DOCUMENT_FRESHNESS_HANDOFF.md`.
