import { createHash } from 'node:crypto';

import type { EmergencyControlScope } from '../../features/emergency-control-runtime/index.js';

/**
 * The canonical persisted form of one emergency control, and its integrity
 * digest.
 *
 * ## What this is, and what it is not
 *
 * **Storage integrity**: a deterministic fingerprint over the exact bytes a row
 * was written as, recomputed on every read, so a row whose fields differ from
 * the ones that were digested is detected and refused rather than believed.
 *
 * **Not cryptographic authenticity.** The digest is unkeyed, exactly as
 * `storedGrantRecordDigest` and the Governance Store's `computeDigest` already
 * are. A writer able to rewrite a row can recompute its digest and re-seal it,
 * and nothing here prevents that. It is not a signature.
 *
 * ## Why the digest matters *more* here than for an ordinary record
 *
 * The dangerous direction is deletion and mutation toward `clear`. An attacker
 * with raw database access who flips `active` from `1` to `0` has silently
 * cancelled a kill switch. The digest covers `active` along with every other
 * field, so a flipped flag no longer matches its own digest and the read
 * reports `unavailable` — which withholds — rather than `clear`.
 *
 * It does not, and cannot, defend against an attacker who recomputes the
 * digest. That boundary is the same one `AUTHORITATIVE_GRANT_STORE.md` §10
 * states for the grant store, and it is stated here rather than implied.
 */

/** The record-envelope format. Bumped only when the canonical bytes change; a record written under another value is not reinterpreted. */
export const EMERGENCY_CONTROL_RECORD_FORMAT = 'aoc.emergency-control-store.record.v1';

/** The store's schema version. A database recorded under another value is refused rather than migrated in place. */
export const EMERGENCY_CONTROL_STORE_SCHEMA_VERSION = 'aoc.emergency-control-store.schema.v1';

export interface StoredEmergencyControl {
  readonly controlKey: string;
  readonly scope: EmergencyControlScope;
  /** Absent for `global`. */
  readonly value?: string;
  readonly active: boolean;
  readonly issuerRef: string;
  readonly declaredAt: string;
}

/** Lexicographic key order fixed here rather than taken from `Object.keys`, no whitespace, no omitted field — the rules `serializeBoundedGrant` and `aoc.canonical-json.v1` already apply. */
export function serializeStoredEmergencyControl(control: StoredEmergencyControl): string {
  return [
    '{',
    [
      `"active":${control.active ? 'true' : 'false'}`,
      `"controlKey":${JSON.stringify(control.controlKey)}`,
      `"declaredAt":${JSON.stringify(control.declaredAt)}`,
      `"format":${JSON.stringify(EMERGENCY_CONTROL_RECORD_FORMAT)}`,
      `"issuerRef":${JSON.stringify(control.issuerRef)}`,
      `"schemaVersion":${JSON.stringify(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION)}`,
      `"scope":${JSON.stringify(control.scope)}`,
      `"value":${control.value === undefined ? 'null' : JSON.stringify(control.value)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeStoredEmergencyControl`. Storage integrity, never a signature. */
export function storedEmergencyControlDigest(control: StoredEmergencyControl): string {
  return `sha256:${createHash('sha256').update(serializeStoredEmergencyControl(control)).digest('hex')}`;
}
