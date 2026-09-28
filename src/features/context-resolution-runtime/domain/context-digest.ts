import { createHash } from 'crypto';

import type { ContextFact, ContextFactValue } from './context-fact.js';
import type { ContextResolution } from './context-resolution.js';

/**
 * CORE-04 — the two digests the Trusted Context Boundary produces.
 *
 * 1. **Provenance digest** of one reading: computed where the reading was
 *    taken, recomputed at admission. A reading whose digest does not recompute
 *    — any field changed in transit, including the reference, the value or the
 *    time — is refused. Integrity, not authenticity (invariant 12): whoever can
 *    rewrite a reading can recompute the digest, which is exactly the limit the
 *    Governance Store states for its own digests.
 *
 * 2. **Admitted-context digest** of a whole resolution: the canonical snapshot
 *    of every admitted fact *including its value*, every unresolved, stale,
 *    conflicted and refused key, and the instant it was resolved at. It travels
 *    on the committed decision (whose record is itself digested) and is bound
 *    into the grant's source, so authority can never rely on context its own
 *    provenance ignores. Values stay out of the record; only this digest of them
 *    enters it.
 *
 * Canonical form: a closed JSON subset — strings, booleans, safe integers,
 * arrays and plain objects with lexicographically sorted keys, no whitespace,
 * `undefined` omitted. There is no floating point in it and no locale
 * behaviour: `isAdmissibleContextFactValue` refuses non-integer numbers before
 * a value can reach here, and anything else is a programming error that throws
 * rather than hashing an ambiguous spelling.
 */

/**
 * v2 (CORE-04 review): the provenance digest covers **every authority-affecting
 * field** a producer states — including `maxAgeSeconds`, which decides whether
 * the reading is fresh, and `attestationRef`, which an attested source's
 * verifier judges. Under v1 neither was covered, so an intermediary could strip
 * or raise a producer's own freshness bound and the reading still verified.
 */
export const CONTEXT_OBSERVATION_PROVENANCE_DOMAIN = 'frontera:context-observation:v2';
export const ADMITTED_CONTEXT_FORMAT = 'frontera.admitted-context.v1';

type CanonicalValue = string | boolean | number | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue | undefined };

function canonical(value: CanonicalValue | undefined): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new TypeError('A context digest admits safe integers only.');
    return String(value);
  }
  if (Array.isArray(value)) return `[${(value as readonly CanonicalValue[]).map((entry) => canonical(entry)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as { readonly [key: string]: CanonicalValue | undefined };
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new TypeError('A context digest admits closed JSON values only.');
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * What a provenance digest covers: the whole reading, as it was taken — every
 * field admission or freshness reads. Only `provenanceDigest` itself is outside
 * it. `contextObservationProvenanceFields` below is the one place that list is
 * spelled, and admission recomputes over exactly it.
 */
export interface ContextObservationProvenanceInput {
  readonly key: string;
  readonly value: ContextFactValue;
  readonly sourceId: string;
  readonly observedAt: string;
  readonly reference: string;
  readonly organizationId?: string;
  /** The producer's own freshness bound. Authority-material: it can only tighten, and removing or raising it would widen. */
  readonly maxAgeSeconds?: number;
  /** The attestation evidence an attested source's verifier judges. */
  readonly attestationRef?: string;
}

/** The provenance digest of one reading. Computed by whoever takes the reading; recomputed by admission. */
export function contextObservationProvenanceDigest(input: ContextObservationProvenanceInput): string {
  return sha256(
    `${CONTEXT_OBSERVATION_PROVENANCE_DOMAIN}\n${canonical({
      key: input.key,
      value: input.value,
      sourceId: input.sourceId,
      observedAt: input.observedAt,
      reference: input.reference,
      organizationId: input.organizationId,
      maxAgeSeconds: input.maxAgeSeconds,
      attestationRef: input.attestationRef,
    })}`,
  );
}

function factSnapshot(fact: ContextFact): CanonicalValue {
  return {
    key: fact.key,
    value: fact.value,
    sourceId: fact.sourceId,
    sourceKind: fact.sourceKind,
    observedAt: fact.observedAt,
    trustClass: fact.trustClass,
    effectiveTrustClass: fact.effectiveTrustClass,
    resolution: fact.resolution,
    staleAt: fact.freshness?.staleAt,
    maxAgeSeconds: fact.freshness?.maxAgeSeconds,
    attestationRef: fact.attestationRef,
    reference: fact.reference,
    provenanceDigest: fact.provenanceDigest,
    conflictingSourceIds: fact.conflictingSourceIds,
    derivation: fact.derivation === undefined ? undefined : { operator: fact.derivation.operator, operandKeys: fact.derivation.operandKeys },
  };
}

/**
 * The admitted-context digest: one deterministic fingerprint of everything a
 * resolution admitted, refused or could not answer, at the instant it was
 * resolved. Order-independent by construction — every list is already stably
 * sorted by the resolution service — and duplicate-safe, because the service
 * reduces agreeing readings to one fact before this runs.
 */
export function contextResolutionDigest(resolution: ContextResolution): string {
  return sha256(
    canonical({
      format: ADMITTED_CONTEXT_FORMAT,
      resolved: resolution.resolved,
      resolvedAt: resolution.resolvedAt,
      declaredKeys: resolution.declaredKeys,
      facts: resolution.facts.map(factSnapshot),
      unresolved: resolution.unresolved,
      stale: resolution.stale,
      conflicted: resolution.conflicted,
      refused: resolution.refused.map((entry) => ({ key: entry.key, sourceId: entry.sourceId, reason: entry.reason })),
      assertedFactPolicy: resolution.assertedFactPolicy,
      assertableKeys: resolution.assertableKeys,
    }),
  );
}
