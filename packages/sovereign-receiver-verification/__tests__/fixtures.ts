// Test-only fixtures. Keys are generated per run with Protocol's own
// primitives; nothing here is a real credential and nothing touches a network.
import { computeContentIdentity, mintSovereignAssetId } from '@aoc/protocol/identity';
import {
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID,
  AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION,
  AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE,
  buildSovereigntyInteroperabilityConsumerSupportV1,
} from '@aoc/protocol/interoperability';
import type { SovereigntyInteroperabilityConsumerSupportV1 } from '@aoc/protocol/interoperability';
import {
  buildOriginClaim,
  buildSovereignManifestV1,
  generateSovereignKeyPair,
  signClaim,
  signSovereignManifest,
} from '@aoc/protocol/manifest';
import type {
  BuildSovereignManifestV1Input,
  OriginClaim,
  SignedClaim,
  SignedSovereignManifest,
  SovereignKeyPair,
} from '@aoc/protocol/manifest';
import {
  SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION,
  buildSovereigntyPortabilityBundleV1,
  serializeSovereigntyPortabilityBundle,
} from '@aoc/protocol/portability';
import type {
  BuildSovereigntyPortabilityBundleV1Input,
  PortableSovereignClaimArtifact,
  PortableSovereignManifestArtifact,
} from '@aoc/protocol/portability';

import type { ReceiverVerificationKeyResolver } from '../src/index.js';

export const ISSUER = 'did:example:issuer';
export const ATTACKER = 'did:example:attacker';
export const SIGNED_AT = new Date('2026-01-01T00:00:00.000Z');
export const CONTENT = new TextEncoder().encode('sovereign asset content bytes');

export const issuerKeys: SovereignKeyPair = generateSovereignKeyPair();
export const attackerKeys: SovereignKeyPair = generateSovereignKeyPair();

export interface ResolverCall {
  readonly issuer: string;
}

/** A resolver that binds each listed issuer to exactly one key, and records every lookup. */
export function trustingResolver(
  bindings: Readonly<Record<string, SovereignKeyPair>> = { [ISSUER]: issuerKeys },
  calls: ResolverCall[] = [],
): ReceiverVerificationKeyResolver {
  return {
    resolveVerificationKey(issuer) {
      calls.push({ issuer });
      const pair = bindings[issuer];
      return pair ? { keyId: pair.signingKey.keyId, issuer, algorithm: 'ed25519' } : undefined;
    },
  };
}

export function consumerSupport(
  overrides: Partial<SovereigntyInteroperabilityConsumerSupportV1> = {},
): SovereigntyInteroperabilityConsumerSupportV1 {
  return {
    ...buildSovereigntyInteroperabilityConsumerSupportV1({
      profile: { id: AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_ID, acceptedVersions: [AOC_SOVEREIGNTY_INTEROPERABILITY_PROFILE_VERSION] },
      mediaTypes: [AOC_SOVEREIGNTY_PORTABILITY_MEDIA_TYPE],
      representationSchemaVersions: [SOVEREIGNTY_PORTABILITY_BUNDLE_SCHEMA_VERSION],
      canonicalizationProfiles: ['aoc-canonical-json/1'],
      artifactKinds: ['signed-manifest', 'signed-claim'],
      claimTypes: ['Origin'],
      standingStatuses: [],
    }),
    ...overrides,
  };
}

/** Manifest overrides; an explicit `undefined` removes a default (e.g. no content commitment). */
export type ManifestOverrides = { readonly [K in keyof BuildSovereignManifestV1Input]?: BuildSovereignManifestV1Input[K] | undefined } & {
  readonly sovereignAssetId: string;
};

export function signedManifest(input: ManifestOverrides, keys: SovereignKeyPair = issuerKeys): SignedSovereignManifest {
  const merged = { registrant: ISSUER, contentIdentity: computeContentIdentity(CONTENT), ...input };
  const defined = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
  const manifest = buildSovereignManifestV1(defined as unknown as BuildSovereignManifestV1Input, SIGNED_AT);
  return signSovereignManifest(manifest, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
}

export function originClaim(sovereignAssetId: string, overrides: Partial<OriginClaim> = {}): OriginClaim {
  return {
    ...buildOriginClaim({
      id: 'claim-origin-1',
      sovereignAssetId,
      issuer: ISSUER,
      assertedOrigin: 'captured by the issuer',
      assertedAt: '2026-01-01T00:00:00.000Z',
    }),
    ...overrides,
  };
}

export function signedOriginClaim(
  sovereignAssetId: string,
  keys: SovereignKeyPair = issuerKeys,
  overrides: Partial<OriginClaim> = {},
): SignedClaim<OriginClaim> {
  return signClaim(originClaim(sovereignAssetId, overrides), keys.privateKeyPem, keys.signingKey, SIGNED_AT);
}

export function manifestArtifact(signed: SignedSovereignManifest): PortableSovereignManifestArtifact {
  return { kind: 'signed-manifest', signedManifest: signed };
}

export function claimArtifact(signed: SignedClaim<OriginClaim>): PortableSovereignClaimArtifact {
  return { kind: 'signed-claim', signedClaim: signed };
}

export function serialize(input: BuildSovereigntyPortabilityBundleV1Input): string {
  return serializeSovereigntyPortabilityBundle(buildSovereigntyPortabilityBundleV1(input));
}

export interface ValidFixture {
  readonly sovereignAssetId: string;
  readonly manifest: SignedSovereignManifest;
  readonly claim: SignedClaim<OriginClaim>;
  readonly text: string;
}

/** One sovereign asset: a signed manifest committing to CONTENT and one signed origin claim. */
export function validFixture(): ValidFixture {
  const sovereignAssetId = mintSovereignAssetId();
  const manifest = signedManifest({ sovereignAssetId });
  const claim = signedOriginClaim(sovereignAssetId);
  const text = serialize({ subject: { sovereignAssetId }, manifests: [manifestArtifact(manifest)], claims: [claimArtifact(claim)] });
  return { sovereignAssetId, manifest, claim, text };
}

export function validOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { verificationKeyResolver: trustingResolver(), consumerSupport: consumerSupport(), contentBytes: CONTENT, ...overrides };
}

/** Edits a canonical bundle as JSON, for shapes Protocol's builders refuse to produce. */
export function editBundleJson(text: string, edit: (bundle: Record<string, unknown>) => void): string {
  const bundle = JSON.parse(text) as Record<string, unknown>;
  edit(bundle);
  return JSON.stringify(bundle);
}
