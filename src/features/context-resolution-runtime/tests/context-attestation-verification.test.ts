import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

import type { ContextFactObservation } from '../domain/context-fact.js';
import type { ContextSource } from '../domain/context-source.js';
import { ContextResolutionService, type ContextAttestationVerifier } from '../services/context-resolution-service.js';

/**
 * CORE-04 review (Codex P1) — an attestation reference is not attestation.
 *
 * `trustClass: 'attested'` means the reading's evidence was *verified*. The
 * boundary itself verifies nothing cryptographic; it admits an attested
 * source's reading only when the deployment's configured verifier accepts the
 * evidence for exactly that source and reading. Here the verifier is a real,
 * deterministic Ed25519 check against a configured issuer and key — no
 * network — so the cases below are what a deployment's verifier would face.
 */

const NOW = '2026-09-28T12:00:00.000Z';
const ATTESTOR: ContextSource = { id: 'kyc-attestor', kind: 'signed_attestation', name: 'KYC attestor', trustClass: 'attested', attests: [{ factClass: 'vendor.verified', maxAgeSeconds: 900 }] };
const DECLARATION = { requirements: [{ key: 'vendor.verified', minimumTrustClass: 'attested' as const, required: true }] };

function keyPair(): { readonly privateKey: KeyObject; readonly publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}
const ISSUER = keyPair();
const ROGUE = keyPair();

/** The bytes an attestation signs: exactly the reading's authority-material fields. */
function attestedBytes(reading: Pick<ContextFactObservation, 'key' | 'value' | 'sourceId' | 'observedAt'>): Buffer {
  return Buffer.from(JSON.stringify({ key: reading.key, observedAt: reading.observedAt, sourceId: reading.sourceId, value: reading.value }), 'utf8');
}

function evidence(reading: Pick<ContextFactObservation, 'key' | 'value' | 'sourceId' | 'observedAt'>, issuer = 'issuer:kyc', privateKey = ISSUER.privateKey): string {
  return Buffer.from(JSON.stringify({ issuer, signature: sign(null, attestedBytes(reading), privateKey).toString('base64url') }), 'utf8').toString('base64url');
}

/** The deployment's configured trust: which issuer, under which key, attests for which source. */
const TRUSTED: ReadonlyMap<string, { readonly issuer: string; readonly publicKey: KeyObject }> = new Map([[ATTESTOR.id, { issuer: 'issuer:kyc', publicKey: createPublicKey(ISSUER.publicKey.export({ type: 'spki', format: 'pem' })) }]]);

const VERIFIER: ContextAttestationVerifier = ({ source, observation }) => {
  const trusted = TRUSTED.get(source.id);
  if (trusted === undefined || typeof observation.attestationRef !== 'string') return false;
  const envelope = JSON.parse(Buffer.from(observation.attestationRef, 'base64url').toString('utf8')) as { issuer?: unknown; signature?: unknown };
  if (envelope.issuer !== trusted.issuer || typeof envelope.signature !== 'string') return false;
  return verify(null, attestedBytes(observation), trusted.publicKey, Buffer.from(envelope.signature, 'base64url'));
};

const reading = (overrides: Partial<ContextFactObservation> = {}): ContextFactObservation => ({ key: 'vendor.verified', value: true, sourceId: ATTESTOR.id, observedAt: new Date(Date.parse(NOW) - 5000).toISOString(), ...overrides });

function classify(observation: ContextFactObservation, attestationVerifier: ContextAttestationVerifier | undefined = VERIFIER) {
  return new ContextResolutionService({ sources: [ATTESTOR], declaration: DECLARATION, ...(attestationVerifier !== undefined ? { attestationVerifier } : {}) }).classify([observation], NOW);
}

describe('CORE-04 review — only verified evidence makes a reading attested', () => {
  it('valid configured evidence → admitted as attested', () => {
    const base = reading();
    const resolution = classify({ ...base, attestationRef: evidence(base) });
    assert.equal(resolution.facts[0]?.trustClass, 'attested');
    assert.deepEqual(resolution.refused, []);
  });

  const refusals: readonly [string, () => ContextObservationWithExpected][] = [
    ['empty reference', () => ({ observation: reading({ attestationRef: '' }), reason: 'attestation_missing' })],
    ['whitespace reference', () => ({ observation: reading({ attestationRef: '   ' }), reason: 'attestation_missing' })],
    ['no reference', () => ({ observation: reading(), reason: 'attestation_missing' })],
    ['invented reference', () => ({ observation: reading({ attestationRef: 'att-12345' }), reason: 'attestation_invalid' })],
    ['wrong issuer (genuine key)', () => ({ observation: { ...reading(), attestationRef: evidence(reading(), 'issuer:someone-else') }, reason: 'attestation_invalid' })],
    ['wrong key (a rogue signer claiming the issuer)', () => ({ observation: { ...reading(), attestationRef: evidence(reading(), 'issuer:kyc', ROGUE.privateKey) }, reason: 'attestation_invalid' })],
    ['tampered evidence (value changed after signing)', () => ({ observation: { ...reading(), attestationRef: evidence(reading()), value: false }, reason: 'attestation_invalid' })],
    ['evidence for another reading (observation time changed)', () => ({ observation: { ...reading(), attestationRef: evidence(reading({ observedAt: NOW })) }, reason: 'attestation_invalid' })],
  ];
  for (const [label, build] of refusals) {
    it(`${label} → refused (${build().reason}), never attested, and the required fact is not satisfied`, () => {
      const { observation, reason } = build();
      const resolution = classify(observation);
      assert.deepEqual(resolution.facts, []);
      assert.deepEqual(resolution.refused, [{ key: 'vendor.verified', sourceId: ATTESTOR.id, reason }]);
    });
  }

  it('no verifier configured → even genuine evidence is refused: the class is never conferred by presence', () => {
    const base = reading();
    const resolution = new ContextResolutionService({ sources: [ATTESTOR], declaration: DECLARATION }).classify([{ ...base, attestationRef: evidence(base) }], NOW);
    assert.deepEqual(resolution.facts, []);
    assert.deepEqual(resolution.refused, [{ key: 'vendor.verified', sourceId: ATTESTOR.id, reason: 'attestation_invalid' }]);
  });

  it('a verifier that throws, or answers anything but true, refuses', () => {
    const base = { ...reading(), attestationRef: evidence(reading()) };
    for (const verifier of [
      (() => {
        throw new Error('boom');
      }) as ContextAttestationVerifier,
      (() => 'yes' as unknown as boolean) as ContextAttestationVerifier,
      (() => 1 as unknown as boolean) as ContextAttestationVerifier,
    ]) {
      assert.deepEqual(classify(base, verifier).facts, []);
    }
  });
});

interface ContextObservationWithExpected {
  readonly observation: ContextFactObservation;
  readonly reason: 'attestation_missing' | 'attestation_invalid';
}
