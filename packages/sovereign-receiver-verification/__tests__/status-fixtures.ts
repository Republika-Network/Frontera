// Test-only signed status fixtures. Keys are generated per run with Protocol's
// own primitives; nothing here is a real credential and nothing touches a network.
import { mintSovereignAssetId } from '@aoc/protocol/identity';
import { signSovereignPayload } from '@aoc/protocol/manifest';
import type { SovereignKeyPair } from '@aoc/protocol/manifest';

import { SOVEREIGN_STATUS_PROFILE, SOVEREIGN_STATUS_PURPOSE } from '../src/index.js';
import { ISSUER, SIGNED_AT, issuerKeys, signedManifest, trustingResolver } from './fixtures.js';

export const ASSET = mintSovereignAssetId();
export const MANIFEST = signedManifest({ sovereignAssetId: ASSET });
export const MANIFEST_DIGEST = MANIFEST.manifestDigest;
export const TERMS = Object.freeze({ claimId: 'claim-terms-1', claimDigest: 'a'.repeat(64) });
export const ISSUED_AT = '2026-10-28T00:00:00.000Z';
export const VALID_UNTIL = '2026-10-29T00:00:00.000Z';
export const NOW = '2026-10-28T12:00:00.000Z';

export type Payload = Record<string, unknown>;

/** A valid `active` status at sequence 1 naming `TERMS`, before any override. */
export function payload(overrides: Payload = {}): Payload {
  return {
    schemaVersion: SOVEREIGN_STATUS_PROFILE,
    purpose: SOVEREIGN_STATUS_PURPOSE,
    sovereignAssetId: ASSET,
    issuer: ISSUER,
    manifestDigest: MANIFEST_DIGEST,
    assetStatus: 'active',
    currentTerms: { ...TERMS },
    sequence: 1,
    previousStatusDigest: null,
    issuedAt: ISSUED_AT,
    validUntil: VALID_UNTIL,
    ...overrides,
  };
}

export interface Envelope {
  status: unknown;
  proof: Record<string, unknown>;
}

export function sign(status: Payload, keys: SovereignKeyPair = issuerKeys): Envelope {
  const proof = signSovereignPayload(status, keys.privateKeyPem, keys.signingKey, SIGNED_AT);
  return { status, proof: { ...proof } };
}

/** `aoc-canonical-json/1` for JSON-safe test values: sorted keys, no whitespace. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

/** The transported text of a status signed by `keys`. */
export function signedText(overrides: Payload = {}, keys: SovereignKeyPair = issuerKeys): string {
  return canonical(sign(payload(overrides), keys));
}

export function statusContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verificationKeyResolver: trustingResolver(),
    expectedSovereignAssetId: ASSET,
    expectedRegistrant: ISSUER,
    expectedManifestDigest: MANIFEST_DIGEST,
    expectedTerms: { ...TERMS },
    evaluationTime: NOW,
    ...overrides,
  };
}

/** A context without `expectedTerms`: the status's terms are reported, not required. */
export function contextWithoutTerms(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const context = statusContext(overrides);
  delete context['expectedTerms'];
  return context;
}
