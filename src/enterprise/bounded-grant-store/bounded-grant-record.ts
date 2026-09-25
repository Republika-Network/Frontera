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

/**
 * The record-envelope format. Bumped only when the canonical bytes change; a record written under another value is not reinterpreted.
 *
 * v2 (CORE-01) adds `storeId` to every envelope. A record is now filed under
 * the store it belongs to as well as the id it is filed under, so a signature
 * produced for one store's authority can never be read as another store's.
 * That binding is what makes the signed revocation-state commitment below
 * specific to *this* store: without it, any genuine commitment signed by the
 * same key — including the empty one every freshly created store signs at
 * genesis — could be spliced over this store's revocations.
 */
export const BOUNDED_GRANT_RECORD_FORMAT = 'aoc.bounded-grant-store.record.v2';

function digestOf(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The canonical envelope for a persisted grant row: the format, the store and id it is filed under, the schema version it was written by, and the grant's own canonical bytes. */
export function serializeStoredGrantRecord(grant: BoundedGrant, storeId: string): string {
  return `{"format":${JSON.stringify(BOUNDED_GRANT_RECORD_FORMAT)},"grant":${serializeBoundedGrant(grant)},"grantId":${JSON.stringify(grant.id)},"kind":"grant","schemaVersion":${JSON.stringify(BOUNDED_GRANT_STORE_SCHEMA_VERSION)},"storeId":${JSON.stringify(storeId)}}`;
}

/** `sha256:<hex>` over `serializeStoredGrantRecord`. Storage integrity, never a signature. */
export function storedGrantRecordDigest(grant: BoundedGrant, storeId: string): string {
  return digestOf(serializeStoredGrantRecord(grant, storeId));
}

/** The canonical envelope for a persisted revocation row. Every field that makes the revocation what it is, and the store it belongs to; nothing derived, nothing optional. */
export function serializeStoredRevocationRecord(revocation: GrantRevocation, storeId: string): string {
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
      `"storeId":${JSON.stringify(storeId)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeStoredRevocationRecord`. Comparable in strength to the grant record's digest, and comparable in what it does not prove. */
export function storedRevocationRecordDigest(revocation: GrantRevocation, storeId: string): string {
  return digestOf(serializeStoredRevocationRecord(revocation, storeId));
}

// ---------------------------------------------------------------------------
// The revocation-state commitment (CORE-01)
// ---------------------------------------------------------------------------

/**
 * One committed revocation, as the revocation-state commitment sees it: its
 * position in the store's revocation sequence, the grant it revokes, and the
 * digest of its record.
 */
export interface RevocationSetEntry {
  readonly sequence: number;
  readonly grantId: string;
  readonly revocationDigest: string;
}

/**
 * The store's whole revocation state, as one signed statement.
 *
 * ## Why this exists
 *
 * A signed revocation proves that a revocation is genuine. It proves nothing
 * about whether revocations are *missing*: deleting a genuine revocation leaves
 * nothing behind to verify, and the grant it revoked is itself still genuine.
 * Before CORE-01 the only record of "this grant has a revocation" was an
 * unsigned pointer on the grant row, so deleting the revocation row and
 * clearing the pointer returned the grant to exactly the bytes it had before
 * it was revoked — and it read as live.
 *
 * The commitment closes that by making the *set* of revocations authority
 * state. It names the store, a strictly increasing `sequence` (the number of
 * revocations ever committed), and a digest over every committed revocation in
 * sequence order. Each revocation re-signs it. A read verifies the signature
 * and recomputes the digest from the rows actually present, so a row that is
 * deleted, added, reordered or re-pointed disagrees with a statement only the
 * authority signing key can produce.
 *
 * ## Absence is never evidence
 *
 * A store with no revocations still holds a commitment — sequence 0, the empty
 * set — signed when the store was created. "No commitment" is therefore never
 * read as "nothing was revoked"; it is inconsistent state, and every read
 * refuses.
 *
 * ## What it does not prove
 *
 * That it is the *latest* commitment. A writer holding an earlier, genuinely
 * signed commitment (copied before a revocation happened) can restore it along
 * with the rows it covered. That is a rollback of the store to an earlier
 * authentic state, and it is out of scope here: CORE-07 owns freshness and
 * anchoring. `docs/security/AUTHORITY_ARTIFACT_AUTHENTICITY.md` states the
 * boundary.
 */
export interface RevocationStateCommitment {
  readonly storeId: string;
  readonly sequence: number;
  readonly revocationSetDigest: string;
}

/** The revocation-set format. Bumped only when the canonical bytes change. */
export const REVOCATION_SET_FORMAT = 'aoc.bounded-grant-store.revocation-set.v1';

/**
 * `sha256:<hex>` over the committed revocations, in sequence order.
 *
 * The caller supplies entries in the order it read them; this does **not**
 * sort. Sorting here would let a row set whose sequence numbers had been
 * rewritten produce the same digest as the original, so ordering is the
 * reader's job and is checked there (contiguous from 1).
 */
export function revocationSetDigest(storeId: string, entries: readonly RevocationSetEntry[]): string {
  const body = entries.map((entry) => [entry.sequence, entry.grantId, entry.revocationDigest]);
  return digestOf(`{"entries":${JSON.stringify(body)},"format":${JSON.stringify(REVOCATION_SET_FORMAT)},"storeId":${JSON.stringify(storeId)}}`);
}

/** The canonical bytes of a revocation-state commitment. Signed under its own domain; see `authority-signature.ts`. */
export function serializeRevocationStateCommitment(state: RevocationStateCommitment): string {
  return [
    '{',
    [
      `"format":${JSON.stringify(BOUNDED_GRANT_RECORD_FORMAT)}`,
      '"kind":"revocation-state"',
      `"revocationSetDigest":${JSON.stringify(state.revocationSetDigest)}`,
      `"schemaVersion":${JSON.stringify(BOUNDED_GRANT_STORE_SCHEMA_VERSION)}`,
      `"sequence":${JSON.stringify(state.sequence)}`,
      `"storeId":${JSON.stringify(state.storeId)}`,
    ].join(','),
    '}',
  ].join('');
}
