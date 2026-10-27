import { isValidSovereignAssetId } from '@aoc/protocol/identity';
import {
  assessSovereigntyInteroperabilityCompatibility,
  tryBuildSovereigntyInteroperabilityDescriptorV1,
  validateSovereigntyInteroperabilityConsumerSupportV1,
} from '@aoc/protocol/interoperability';
import type { SovereigntyInteroperabilityConsumerSupportV1 } from '@aoc/protocol/interoperability';
import { SovereignAssetState, verifySignedSovereignClaim, verifySovereignManifest } from '@aoc/protocol/manifest';
import type {
  SignedClaim,
  SignedSovereignManifest,
  SovereignClaimVerificationResult,
  SovereignManifestVerificationResult,
} from '@aoc/protocol/manifest';
import {
  SOVEREIGNTY_PORTABILITY_REASON_CODES,
  parseSovereigntyPortabilityBundle,
  serializeSovereigntyPortabilityBundle,
} from '@aoc/protocol/portability';
import type { SovereigntyPortabilityBundleV1, SovereigntyPortabilityReasonCode } from '@aoc/protocol/portability';

import type { ReceiverVerificationRejectionReason } from './reasons.js';
import { STRICT_RECEIVER_PROFILE } from './types.js';
import type {
  ReceivedSovereignAssetRejected,
  ReceivedSovereignAssetVerificationResult,
  ReceiverVerificationKeyResolver,
  VerifiedClaimEvidence,
  VerifiedManifestEvidence,
} from './types.js';

type Reason = ReceiverVerificationRejectionReason;

const OPTION_KEYS = new Set([
  'verificationKeyResolver',
  'consumerSupport',
  'expectedSovereignAssetId',
  'expectedIssuer',
  'contentBytes',
]);

/** How many prototype levels of an options object are inspected before it is refused. */
const MAX_OPTIONS_PROTOTYPE_DEPTH = 8;

// Intrinsics captured at load, so neither a caller's subclass nor a later
// patch of the prototypes can change how content bytes are recognized or copied.
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayTag = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length')!.get!;
const typedArraySet = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'set')!.value as (source: ArrayLike<number>) => void;

const PORTABILITY_REASONS: Readonly<Record<SovereigntyPortabilityReasonCode, Reason>> = {
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidBundle]: 'BUNDLE_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidJson]: 'BUNDLE_MALFORMED',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.unsupportedBundleSchema]: 'BUNDLE_UNSUPPORTED_SCHEMA',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.unsupportedCanonicalizationProfile]: 'BUNDLE_UNSUPPORTED_CANONICALIZATION',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidSubject]: 'SUBJECT_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidManifestArtifact]: 'MANIFEST_STRUCTURE_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.manifestSubjectMismatch]: 'SUBJECT_MISMATCH',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.duplicateManifestVersion]: 'DUPLICATE_MANIFEST_VERSION',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidClaimArtifact]: 'CLAIM_STRUCTURE_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.claimSubjectMismatch]: 'SUBJECT_MISMATCH',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.duplicateClaimId]: 'DUPLICATE_CLAIM_ID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.invalidStanding]: 'STANDING_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.duplicateStandingId]: 'STANDING_INVALID',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.danglingStandingClaimRef]: 'MISSING_REFERENCED_CLAIM',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.unsupportedArtifactKind]: 'UNSUPPORTED_ARTIFACT_KIND',
  [SOVEREIGNTY_PORTABILITY_REASON_CODES.canonicalizationFailed]: 'BUNDLE_INVALID',
};

interface OptionsSnapshot {
  readonly resolver: ReceiverVerificationKeyResolver;
  readonly consumerSupport: SovereigntyInteroperabilityConsumerSupportV1;
  readonly expectedSovereignAssetId: string | undefined;
  readonly expectedIssuer: string | undefined;
  readonly contentBytes: Uint8Array | undefined;
}

type OptionsOutcome = { readonly ok: true; readonly options: OptionsSnapshot } | { readonly ok: false; readonly reason: Reason };

/** Records whether the caller's resolver failed during one verification call. */
interface ResolverState {
  failed: boolean;
}

/**
 * Strictly verifies a received, serialized sovereign portability bundle.
 *
 * `verified` means every artifact in the bundle passed Protocol's own
 * verification with an issuer binding to a trusted key, and that this receiver
 * can consume the representation in full. It is not an authorization decision:
 * it grants nothing, issues no execution capability, and does not evaluate
 * revocation or freshness. Never throws; every failure is a closed rejection.
 */
export async function verifyReceivedSovereignAsset(
  bundleText: unknown,
  options: unknown,
): Promise<ReceivedSovereignAssetVerificationResult> {
  try {
    return await verifyStrict(bundleText, options);
  } catch {
    return rejected(['INTERNAL_VERIFICATION_ERROR']);
  }
}

async function verifyStrict(bundleText: unknown, rawOptions: unknown): Promise<ReceivedSovereignAssetVerificationResult> {
  if (typeof bundleText !== 'string') return rejected(['INVALID_INPUT']);

  const optionsOutcome = snapshotOptions(rawOptions);
  if (!optionsOutcome.ok) return rejected([optionsOutcome.reason]);
  const options = optionsOutcome.options;

  // 1. Strict parsing: Protocol's parser, then canonical bytes only. The parser
  //    reorders a shuffled envelope; a strict receiver refuses it instead.
  const parsed = parseSovereigntyPortabilityBundle(bundleText);
  if (!parsed.valid) return rejected(parsed.reasons.map(mapPortabilityReason));
  const bundle = parsed.bundle;
  if (serializeSovereigntyPortabilityBundle(bundle) !== bundleText) return rejected(['BUNDLE_NOT_CANONICAL']);

  // 2. Identity and strict-profile rules, before any resolver is consulted.
  const policyReasons: Reason[] = [];
  const sovereignAssetId = bundle.subject.sovereignAssetId;
  if (options.expectedSovereignAssetId !== undefined && sovereignAssetId !== options.expectedSovereignAssetId) {
    policyReasons.push('SUBJECT_MISMATCH');
  }
  const signedManifests: SignedSovereignManifest[] = [];
  for (const artifact of bundle.manifests) {
    if (artifact.kind === 'signed-manifest') signedManifests.push(artifact.signedManifest);
    else policyReasons.push('UNSIGNED_MANIFEST');
  }
  if (signedManifests.length === 0) policyReasons.push('NO_SIGNED_MANIFEST');
  const signedClaims: SignedClaim[] = [];
  for (const artifact of bundle.claims) {
    if (artifact.kind === 'signed-claim') signedClaims.push(artifact.signedClaim);
    else policyReasons.push('UNSIGNED_CLAIM');
  }
  // Registrant continuity: rc.3 manifests do not chain, and nothing in a bundle
  // transfers authority, so every version must name the same canonical issuer
  // (the identity the binding resolves). A valid signature on a later version
  // from another issuer does not make it this asset's current record.
  const registrants = new Set(signedManifests.map((signed) => issuerId(signed.manifest.registrant)));
  if (registrants.size > 1) policyReasons.push('REGISTRANT_DISCONTINUITY');
  // The highest version present is the current one. A current manifest that
  // records itself as superseded contradicts the bundle that carries it.
  const current = signedManifests.reduce<SignedSovereignManifest | undefined>(
    (a, b) => (a === undefined || b.manifest.manifestVersion > a.manifest.manifestVersion ? b : a),
    undefined,
  );
  if (current?.manifest.state === SovereignAssetState.Superseded) policyReasons.push('CURRENT_MANIFEST_SUPERSEDED');
  // Standings travel unsigned and are not verified here. They are accepted only
  // as Protocol-valid structure (checked by the parser) and reported as such.
  if (policyReasons.length > 0) return rejected(policyReasons);
  if (current === undefined) return rejected(['NO_SIGNED_MANIFEST']);

  // 3. Exact compatibility with what this receiver declared it supports.
  const compatibilityReason = assessCompatibility(bundle, options.consumerSupport);
  if (compatibilityReason) return rejected([compatibilityReason]);

  // 4. Content identity is required wherever the current manifest commits to one.
  const contentRequired = current.manifest.contentIdentity !== undefined;
  if (contentRequired && options.contentBytes === undefined) return rejected(['CONTENT_BYTES_REQUIRED']);
  if (!contentRequired && options.contentBytes !== undefined) return rejected(['CONTENT_IDENTITY_NOT_DECLARED']);

  // 5. Cryptographic verification, through Protocol only.
  const state: ResolverState = { failed: false };
  const resolver = guardResolver(options.resolver, state);
  const reasons: Reason[] = [];
  const manifests: VerifiedManifestEvidence[] = [];
  for (const signed of signedManifests) {
    const isCurrent = signed === current;
    state.failed = false;
    const result = await verifySovereignManifest(signed, {
      verificationKeyResolver: resolver,
      ...(options.expectedIssuer !== undefined ? { issuer: options.expectedIssuer } : {}),
      ...(isCurrent && options.contentBytes !== undefined ? { contentBytes: options.contentBytes } : {}),
    });
    const manifestReasons = manifestRejections(result, isCurrent && contentRequired, state.failed);
    if (manifestReasons.length > 0) {
      reasons.push(...manifestReasons);
      continue;
    }
    const issuer = issuerId(signed.manifest.registrant);
    if (issuer === undefined) {
      reasons.push('ISSUER_BINDING_NOT_PERFORMED');
      continue;
    }
    manifests.push({
      manifestVersion: signed.manifest.manifestVersion,
      manifestDigest: signed.manifestDigest,
      issuer,
      keyId: signed.proof.keyId,
      state: signed.manifest.state,
    });
  }

  const claims: VerifiedClaimEvidence[] = [];
  for (const signed of signedClaims) {
    state.failed = false;
    // No expected issuer: a claim's own signed issuer is the only one bound.
    const result = await verifySignedSovereignClaim(signed, { verificationKeyResolver: resolver });
    const claimReasons = claimRejections(result, state.failed);
    if (claimReasons.length > 0) {
      reasons.push(...claimReasons);
      continue;
    }
    const issuer = issuerId(signed.claim.issuer);
    if (issuer === undefined) {
      reasons.push('ISSUER_BINDING_NOT_PERFORMED');
      continue;
    }
    claims.push({ claimId: signed.claim.id, claimType: signed.claim.type, issuer, keyId: signed.proof.keyId });
  }

  if (reasons.length > 0) return rejected(reasons);
  // The current issuer comes from the verified binding, never from the caller.
  const currentEvidence = manifests.find((evidence) => evidence.manifestVersion === current.manifest.manifestVersion);
  if (currentEvidence === undefined) return rejected(['INTERNAL_VERIFICATION_ERROR']);

  return deepFreeze({
    outcome: 'verified',
    profile: STRICT_RECEIVER_PROFILE,
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    sovereignAssetId,
    currentManifestVersion: current.manifest.manifestVersion,
    currentManifestBasis: 'highest_version_in_bundle',
    currentIssuer: currentEvidence.issuer,
    currentState: currentEvidence.state,
    contentIdentity: contentRequired ? 'verified' : 'not_declared',
    compatibility: 'compatible',
    standings: bundle.standings.length > 0 ? 'present_unverified' : 'none',
    manifests: manifests.sort((a, b) => a.manifestVersion - b.manifestVersion),
    claims: claims.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0)),
    reasons: [],
  });
}

/**
 * Reads every option exactly once into a plain snapshot, so a getter or proxy
 * cannot show one value to validation and another to verification.
 *
 * Layout policy: the options object and its prototypes up to (not including)
 * `Object.prototype` are inspected without invoking anything but proxy traps.
 * A recognized option found there, whether own or inherited, enumerable or not,
 * a data property or a getter, is read once and honoured: a constraint is never
 * silently dropped. Any other string key there (bar a prototype's `constructor`)
 * is refused, because an unrecognized option must never be silently ignored.
 * `Object.prototype` is not a configuration source: a recognized option that
 * reads as defined without appearing in the inspected chain (a polluted global
 * prototype, or a proxy hiding its keys) is refused.
 */
function snapshotOptions(raw: unknown): OptionsOutcome {
  const invalid = { ok: false, reason: 'INVALID_OPTIONS' } as const;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid;
  const values = new Map<string, unknown>();
  try {
    const located = new Set<string>();
    let level: object | null = raw;
    for (let depth = 0; level !== null && level !== Object.prototype; depth += 1) {
      if (depth === MAX_OPTIONS_PROTOTYPE_DEPTH) return invalid;
      for (const key of Reflect.ownKeys(level)) {
        if (typeof key !== 'string' || (depth > 0 && key === 'constructor')) continue;
        if (!OPTION_KEYS.has(key)) return invalid;
        located.add(key);
      }
      level = Reflect.getPrototypeOf(level);
    }
    for (const key of OPTION_KEYS) {
      const value: unknown = Reflect.get(raw, key);
      if (!located.has(key) && value !== undefined) return invalid;
      values.set(key, value);
    }
  } catch {
    return invalid;
  }

  const resolverObject = values.get('verificationKeyResolver');
  if (typeof resolverObject !== 'object' || resolverObject === null) return invalid;
  let resolve: unknown;
  try {
    resolve = (resolverObject as Record<string, unknown>)['resolveVerificationKey'];
  } catch {
    return invalid;
  }
  if (typeof resolve !== 'function') return invalid;
  const boundResolve = resolve as ReceiverVerificationKeyResolver['resolveVerificationKey'];
  const resolver: ReceiverVerificationKeyResolver = {
    resolveVerificationKey: (issuer) => Reflect.apply(boundResolve, resolverObject, [issuer]),
  };

  // A JSON round trip reads the declaration once and leaves plain data.
  let consumerSupport: unknown;
  try {
    const supplied = values.get('consumerSupport');
    if (supplied === undefined) return invalid;
    consumerSupport = JSON.parse(JSON.stringify(supplied));
  } catch {
    return { ok: false, reason: 'CONSUMER_SUPPORT_INVALID' };
  }
  if (!validateSovereigntyInteroperabilityConsumerSupportV1(consumerSupport).valid) {
    return { ok: false, reason: 'CONSUMER_SUPPORT_INVALID' };
  }

  const expectedSovereignAssetId = values.get('expectedSovereignAssetId');
  if (expectedSovereignAssetId !== undefined && !isValidSovereignAssetId(expectedSovereignAssetId)) return invalid;

  const expectedIssuer = values.get('expectedIssuer');
  if (expectedIssuer !== undefined && (typeof expectedIssuer !== 'string' || expectedIssuer.trim() === '')) return invalid;

  const suppliedBytes = values.get('contentBytes');
  let contentBytes: Uint8Array | undefined;
  if (suppliedBytes !== undefined) {
    try {
      // The intrinsic brand: a real Uint8Array (subclasses such as Buffer
      // included); a proxy or an object with a borrowed prototype has none.
      if (Reflect.apply(typedArrayTag, suppliedBytes, []) !== 'Uint8Array') return invalid;
      // A private copy in a fresh intrinsic buffer, read from the source's
      // internal slots. Unlike `slice`, no species constructor is consulted, so
      // the snapshot can never alias bytes the caller can still change.
      const length = Reflect.apply(typedArrayLength, suppliedBytes, []) as number;
      contentBytes = new Uint8Array(length);
      Reflect.apply(typedArraySet, contentBytes, [suppliedBytes]);
    } catch {
      return invalid;
    }
  }

  return {
    ok: true,
    options: {
      resolver,
      consumerSupport: consumerSupport as SovereigntyInteroperabilityConsumerSupportV1,
      expectedSovereignAssetId,
      expectedIssuer,
      contentBytes,
    },
  };
}

/**
 * A resolver failure is recorded and answered with "no key", which Protocol
 * treats as an unverified binding; it is never allowed to escape as an
 * exception or to be mistaken for an absent check.
 */
function guardResolver(resolver: ReceiverVerificationKeyResolver, state: ResolverState): ReceiverVerificationKeyResolver {
  return {
    resolveVerificationKey: async (issuer) => {
      try {
        return await resolver.resolveVerificationKey(issuer);
      } catch {
        state.failed = true;
        return undefined;
      }
    },
  };
}

function assessCompatibility(
  bundle: SovereigntyPortabilityBundleV1,
  consumerSupport: SovereigntyInteroperabilityConsumerSupportV1,
): Reason | undefined {
  const described = tryBuildSovereigntyInteroperabilityDescriptorV1(bundle);
  if (!described.valid) return 'BUNDLE_INVALID';
  const report = assessSovereigntyInteroperabilityCompatibility(described.descriptor, consumerSupport);
  if (report.status === 'compatible') return undefined;
  return report.status === 'partially-compatible' ? 'INTEROPERABILITY_PARTIAL' : 'INTEROPERABILITY_INCOMPATIBLE';
}

/**
 * Accepts a manifest only on positive evidence for every check. Protocol's
 * `valid` alone is not enough: it stays true when the issuer binding was
 * `not_performed`.
 */
function manifestRejections(result: SovereignManifestVerificationResult, contentRequired: boolean, resolverFailed: boolean): Reason[] {
  const reasons: Reason[] = [];
  const { checks } = result;
  if (checks.manifestStructure !== 'valid') reasons.push('MANIFEST_STRUCTURE_INVALID');
  if (checks.manifestDigest !== 'valid' || result.reasons.includes('PROOF_PAYLOAD_HASH_MISMATCH')) reasons.push('MANIFEST_DIGEST_MISMATCH');
  if (checks.signature !== 'valid') reasons.push('MANIFEST_SIGNATURE_INVALID');
  if (contentRequired && checks.contentDigest !== 'valid') reasons.push('CONTENT_DIGEST_MISMATCH');
  reasons.push(...bindingRejections(checks.issuerBinding, result.reasons, resolverFailed));
  if (reasons.length === 0 && result.valid !== true) reasons.push('MANIFEST_VERIFICATION_FAILED');
  return reasons;
}

function claimRejections(result: SovereignClaimVerificationResult, resolverFailed: boolean): Reason[] {
  const reasons: Reason[] = [];
  const { checks } = result;
  if (checks.claimStructure !== 'valid') reasons.push('CLAIM_STRUCTURE_INVALID');
  if (checks.claimDigest !== 'valid') reasons.push('CLAIM_DIGEST_MISMATCH');
  if (checks.signature !== 'valid') reasons.push('CLAIM_SIGNATURE_INVALID');
  reasons.push(...bindingRejections(checks.issuerBinding, result.reasons, resolverFailed));
  if (reasons.length === 0 && result.valid !== true) reasons.push('CLAIM_VERIFICATION_FAILED');
  return reasons;
}

function bindingRejections(binding: string, protocolReasons: readonly string[], resolverFailed: boolean): Reason[] {
  if (resolverFailed) return ['KEY_RESOLVER_FAILED'];
  if (binding === 'verified') return [];
  if (protocolReasons.includes('ISSUER_BINDING_ISSUER_MISMATCH')) return ['ISSUER_BINDING_MISMATCH'];
  if (binding === 'not_performed') return ['ISSUER_BINDING_NOT_PERFORMED'];
  return ['ISSUER_BINDING_UNVERIFIED'];
}

function mapPortabilityReason(code: SovereigntyPortabilityReasonCode): Reason {
  return Object.prototype.hasOwnProperty.call(PORTABILITY_REASONS, code) ? PORTABILITY_REASONS[code] : 'BUNDLE_INVALID';
}

function issuerId(issuer: unknown): string | undefined {
  if (typeof issuer === 'string' && issuer.trim() !== '') return issuer;
  if (typeof issuer === 'object' && issuer !== null) {
    const id = (issuer as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id.trim() !== '') return id;
  }
  return undefined;
}

function rejected(reasons: readonly Reason[]): ReceivedSovereignAssetRejected {
  return deepFreeze({
    outcome: 'rejected',
    profile: STRICT_RECEIVER_PROFILE,
    authorization: 'not_evaluated',
    revocation: 'not_evaluated',
    freshness: 'not_evaluated',
    reasons: [...new Set(reasons)].sort(),
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
