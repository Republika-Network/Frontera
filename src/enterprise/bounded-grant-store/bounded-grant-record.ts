import { createHash } from 'node:crypto';

import {
  BOUNDED_GRANT_STORE_SCHEMA_VERSION,
  serializeBoundedGrant,
  type BoundedGrant,
  type GrantRevocation,
} from '../../features/grant-runtime/index.js';

/**
 * The canonical persisted form of one authority record, and its integrity
 * digest.
 *
 * ## What this is, and what it is emphatically not
 *
 * It is **storage integrity**: a deterministic fingerprint over the exact bytes
 * a record was written as, recomputed on every authoritative read, so a record
 * whose fields differ from the ones that were digested is detected and refused
 * rather than used.
 *
 * It is **not cryptographic authenticity**. The digest is unkeyed, exactly as
 * `boundedGrantDigest` and the Governance Store's `computeDigest` already are.
 * A writer able to rewrite a record can recompute its digest and re-seal it,
 * and nothing here prevents that. It is not a signature, it carries no
 * non-repudiation, and no claim in this repository may call it one.
 * Authenticity is a separate mechanism kept beside it: a detached Ed25519
 * signature over the same canonical bytes, under an artifact-specific signing
 * domain (`../authority-authenticity/`,
 * `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md`).
 *
 * ## Why an envelope rather than the artifact's own digest
 *
 * `BoundedGrant` already carries `digest`, over its own fields. That value
 * travels *with* the artifact, so a read that verified only it would be asking
 * the record to vouch for itself in the one respect a storage layer must check
 * independently: that this row is the row that was written, for this id, under
 * this schema version. The envelope binds all three. A read verifies **both** —
 * the envelope here, and the artifact's own digest through
 * `boundedGrantDigestMatches` — because they detect different substitutions.
 *
 * ## Why revocations get one too
 *
 * A revocation is authority state, not audit metadata. `NB-009` recorded that
 * revocation records carry no digest at all; a durable store in which a grant
 * is integrity-protected and its revocation is not would make the revocation
 * the cheaper record to forge, which inverts the fail-closed direction the
 * whole design rests on.
 *
 * ## Canonical form
 *
 * Lexicographic key order fixed here rather than taken from `Object.keys`, no
 * whitespace, no omitted field — the same rules `serializeBoundedGrant` and
 * `aoc.canonical-json.v1` apply, so the bytes a digest is taken over are the
 * bytes any other reader would produce.
 */

/** The record-envelope format. Bumped only when the canonical bytes change; a record written under another value is not reinterpreted. */
export const BOUNDED_GRANT_RECORD_FORMAT = 'aoc.bounded-grant-store.record.v1';

function digestOf(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The canonical envelope for a persisted grant row: the format, the id it is filed under, the schema version it was written by, and the grant's own canonical bytes. */
export function serializeStoredGrantRecord(grant: BoundedGrant): string {
  return `{"format":${JSON.stringify(BOUNDED_GRANT_RECORD_FORMAT)},"grant":${serializeBoundedGrant(grant)},"grantId":${JSON.stringify(grant.id)},"kind":"grant","schemaVersion":${JSON.stringify(BOUNDED_GRANT_STORE_SCHEMA_VERSION)}}`;
}

/** `sha256:<hex>` over `serializeStoredGrantRecord`. Storage integrity, never a signature. */
export function storedGrantRecordDigest(grant: BoundedGrant): string {
  return digestOf(serializeStoredGrantRecord(grant));
}

/** The canonical envelope for a persisted revocation row. Every field that makes the revocation what it is; nothing derived, nothing optional. */
export function serializeStoredRevocationRecord(revocation: GrantRevocation): string {
  return [
    '{',
    [
      `"format":${JSON.stringify(BOUNDED_GRANT_RECORD_FORMAT)}`,
      `"grantId":${JSON.stringify(revocation.grantId)}`,
      `"issuerRef":${JSON.stringify(revocation.issuerRef)}`,
      '"kind":"revocation"',
      `"reason":${JSON.stringify(revocation.reason)}`,
      `"revokedAt":${JSON.stringify(revocation.revokedAt)}`,
      `"schemaVersion":${JSON.stringify(BOUNDED_GRANT_STORE_SCHEMA_VERSION)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeStoredRevocationRecord`. Comparable in strength to the grant record's digest, and comparable in what it does not prove. */
export function storedRevocationRecordDigest(revocation: GrantRevocation): string {
  return digestOf(serializeStoredRevocationRecord(revocation));
}
