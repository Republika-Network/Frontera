import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContextResolutionService, contextObservationProvenanceDigest, type ContextFactObservation, type ContextSource } from '../index.js';

/**
 * CORE-04 review (Codex P1) — freshness is authority-material, so it is
 * provenance-material.
 *
 * A producer that states its own `maxAgeSeconds` tightens the source's bound
 * for that reading; admission takes the strictest bound. Under the v1 digest
 * that field was outside the provenance, so an intermediary could strip it,
 * or raise it, and extend the window the producer intended — while the
 * reading still verified. The v2 digest covers every authority-affecting
 * field the reading states (including its attestation evidence).
 */

const ORG = 'org-a';
const NOW = '2026-09-28T12:00:00.000Z';
const secondsAgo = (seconds: number): string => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

const ERP: ContextSource = { id: 'erp-primary', kind: 'erp', name: 'ERP', trustClass: 'authoritative', organizationId: ORG, provenance: 'reference-digest', attests: [{ factClass: 'invoice.exists', maxAgeSeconds: 900 }] };
const ATTESTOR: ContextSource = { id: 'kyc', kind: 'signed_attestation', name: 'KYC', trustClass: 'attested', organizationId: ORG, provenance: 'reference-digest', attests: [{ factClass: 'vendor.verified', maxAgeSeconds: 900 }] };

function service(): ContextResolutionService {
  return new ContextResolutionService({
    sources: [ERP, ATTESTOR],
    declaration: {
      requirements: [
        { key: 'invoice.exists', minimumTrustClass: 'authoritative', required: true },
        { key: 'vendor.verified', minimumTrustClass: 'attested', required: false },
      ],
    },
    // Accepts any non-empty evidence: this suite is about provenance, not verification.
    attestationVerifier: ({ observation }) => typeof observation.attestationRef === 'string',
  });
}

/** A reading the producer took 120 s ago and declared good for 60 s — digest over the whole reading, bound included. */
function producerReading(maxAgeSeconds: number | undefined = 60): ContextFactObservation {
  const base = { key: 'invoice.exists', value: true, sourceId: ERP.id, observedAt: secondsAgo(120), reference: 'erp:invoice-1', ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}) };
  return { ...base, provenanceDigest: contextObservationProvenanceDigest(base) };
}

const classify = (observation: ContextFactObservation) => service().classify([observation], NOW, ORG);

describe('CORE-04 review — maxAgeSeconds is bound to the provenance digest', () => {
  it('the original reading verifies, is admitted, and is stale under the producer’s own 60 s bound (not the source’s 900 s)', () => {
    const resolution = classify(producerReading());
    assert.deepEqual(resolution.refused, []);
    assert.equal(resolution.facts[0]?.freshness?.maxAgeSeconds, 60);
    assert.deepEqual(resolution.stale, ['invoice.exists']);
  });

  it('removing maxAgeSeconds in transit → digest mismatch, refused (it would have widened freshness to 900 s)', () => {
    const { maxAgeSeconds: _stripped, ...stripped } = producerReading();
    assert.deepEqual(classify(stripped).refused, [{ key: 'invoice.exists', sourceId: ERP.id, reason: 'provenance_invalid' }]);
  });

  it('increasing maxAgeSeconds in transit → digest mismatch, refused', () => {
    assert.deepEqual(classify({ ...producerReading(), maxAgeSeconds: 900 }).refused, [{ key: 'invoice.exists', sourceId: ERP.id, reason: 'provenance_invalid' }]);
  });

  it('decreasing maxAgeSeconds in transit → digest mismatch, refused — unless the producer recomputes it legitimately', () => {
    assert.deepEqual(classify({ ...producerReading(), maxAgeSeconds: 30 }).refused, [{ key: 'invoice.exists', sourceId: ERP.id, reason: 'provenance_invalid' }]);
    const recomputed = classify(producerReading(30));
    assert.deepEqual(recomputed.refused, []);
    assert.equal(recomputed.facts[0]?.freshness?.maxAgeSeconds, 30);
  });

  it('adding a bound the producer never stated → digest mismatch, refused', () => {
    assert.deepEqual(classify({ ...producerReading(undefined), maxAgeSeconds: 600 }).refused, [{ key: 'invoice.exists', sourceId: ERP.id, reason: 'provenance_invalid' }]);
  });

  it('a malformed bound cannot be canonicalized: provenance_invalid, never a throw', () => {
    for (const bad of [1.5, Number.NaN, -1, Number.MAX_SAFE_INTEGER + 2]) {
      const base = { key: 'invoice.exists', value: true, sourceId: ERP.id, observedAt: secondsAgo(5), reference: 'erp:invoice-1' };
      const observation = { ...base, provenanceDigest: contextObservationProvenanceDigest(base), maxAgeSeconds: bad };
      assert.doesNotThrow(() => classify(observation));
      assert.equal(classify(observation).refused[0]?.reason, 'provenance_invalid', String(bad));
    }
  });

  it('attestation evidence is provenance-material too: swapping it in transit → refused', () => {
    const base = { key: 'vendor.verified', value: true, sourceId: ATTESTOR.id, observedAt: secondsAgo(5), reference: 'kyc:vendor-1', attestationRef: 'evidence-original' };
    const genuine = { ...base, provenanceDigest: contextObservationProvenanceDigest(base) };
    assert.deepEqual(classify(genuine).refused, []);
    assert.deepEqual(classify({ ...genuine, attestationRef: 'evidence-substituted' }).refused, [{ key: 'vendor.verified', sourceId: ATTESTOR.id, reason: 'provenance_invalid' }]);
  });
});
