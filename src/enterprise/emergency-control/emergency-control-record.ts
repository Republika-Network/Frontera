import { createHash } from 'node:crypto';

import type { EmergencyControlScope } from '../../features/emergency-control-runtime/index.js';

/**
 * The canonical persisted forms of the emergency-control store, and their
 * integrity digests.
 *
 * ## Three records, because one was not enough
 *
 * An earlier revision persisted **only** a current-state row per control, with
 * a digest over its fields. That digest makes a *modified* row detectable — a
 * flipped `active` flag no longer matches — and it is completely silent about
 * a row that is **no longer there**. Row absent and "no control was ever
 * declared" were the same observable state, so deleting an active control read
 * back as `clear`.
 *
 * For a grant store that would fail closed: losing a grant removes authority.
 * For a kill switch it fails **open** — the stop silently stops stopping — and
 * that is the one direction this whole capability exists to remove. Ordinary
 * operator release already has its own explicit operation, so a row that simply
 * vanishes is not a release; it is state that cannot be established.
 *
 * So the store keeps three records that vouch for each other, which is the
 * shape `AUTHORITATIVE_GRANT_STORE.md` §9.1 already uses for a grant and its
 * revocation:
 *
 * | record | what it is |
 * | --- | --- |
 * | **event** | append-only, sequenced, hash-chained. One row per operator transition: `activated` or `released`. |
 * | **control** | the current-state projection, carrying a pointer to the event that produced it. |
 * | **head** | one row. The sequence, the count and the digest of the latest event. |
 *
 * A read cross-checks all three, so every partial deletion is detectable:
 *
 * - control row deleted, events intact → the key has events and no projection
 *   → `unavailable`.
 * - events deleted → the head's count/sequence no longer match the table →
 *   `unavailable`.
 * - head deleted → an initialized store always has one → `unavailable`.
 * - projection re-pointed at another event, or left behind a newer one →
 *   `unavailable`.
 *
 * ## What this is, and what it is not
 *
 * **Storage integrity.** Every digest here is **unkeyed** SHA-256, exactly as
 * `storedGrantRecordDigest` and the Governance Store's `computeDigest` already
 * are. It detects mutation and — now — deletion of *part* of the state. It does
 * **not** stop a writer who rewrites every record and recomputes every digest,
 * and it is not a signature. Nor can anything inside one file detect that file
 * being replaced wholesale with a blank one: that is the same anti-rollback
 * gap the grant store records as GS-002, and it needs an anchor outside the
 * database. `docs/enterprise/AOC_EMERGENCY_CONTROL.md` §8 states both limits.
 */

/** The record-envelope format. Bumped only when the canonical bytes change; a record written under another value is not reinterpreted. */
export const EMERGENCY_CONTROL_RECORD_FORMAT = 'aoc.emergency-control-store.record.v2';

/**
 * The store's schema version.
 *
 * `v2` because `v1` held only the projection and could not detect a deleted
 * control. A `v1` file is **refused** at open rather than read under these
 * rules: a database that cannot prove an active stop was not removed is not one
 * this runtime will answer `clear` from.
 */
export const EMERGENCY_CONTROL_STORE_SCHEMA_VERSION = 'aoc.emergency-control-store.schema.v2';

/** The two transitions an operator can record. A control's current state is always the latest event for its key. */
export type EmergencyControlTransition = 'activated' | 'released';

export function isEmergencyControlTransition(value: unknown): value is EmergencyControlTransition {
  return value === 'activated' || value === 'released';
}

function digestOf(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/** The chain's anchor. The `previousEventDigest` of the first event, and the head's digest while no event exists. */
export const EMERGENCY_CONTROL_GENESIS_DIGEST = digestOf(
  `{"format":${JSON.stringify(EMERGENCY_CONTROL_RECORD_FORMAT)},"kind":"genesis","schemaVersion":${JSON.stringify(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION)}}`,
);

export interface EmergencyControlEventRecord {
  /** 1-based, contiguous, assigned by the store. Also what the head counts. */
  readonly sequence: number;
  readonly controlKey: string;
  readonly scope: EmergencyControlScope;
  /** Absent for `global`. */
  readonly value?: string;
  readonly transition: EmergencyControlTransition;
  /** Who recorded it. Operator audit; never returned by a read. */
  readonly issuerRef: string;
  readonly recordedAt: string;
  /** The previous event's digest, or the genesis digest for the first. */
  readonly previousEventDigest: string;
}

/** Lexicographic key order fixed here rather than taken from `Object.keys`, no whitespace, no omitted field. */
export function serializeEmergencyControlEvent(event: EmergencyControlEventRecord): string {
  return [
    '{',
    [
      `"controlKey":${JSON.stringify(event.controlKey)}`,
      `"format":${JSON.stringify(EMERGENCY_CONTROL_RECORD_FORMAT)}`,
      '"kind":"event"',
      `"issuerRef":${JSON.stringify(event.issuerRef)}`,
      `"previousEventDigest":${JSON.stringify(event.previousEventDigest)}`,
      `"recordedAt":${JSON.stringify(event.recordedAt)}`,
      `"schemaVersion":${JSON.stringify(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION)}`,
      `"scope":${JSON.stringify(event.scope)}`,
      `"sequence":${String(event.sequence)}`,
      `"transition":${JSON.stringify(event.transition)}`,
      `"value":${event.value === undefined ? 'null' : JSON.stringify(event.value)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeEmergencyControlEvent`, chained through `previousEventDigest`. Storage integrity, never a signature. */
export function emergencyControlEventDigest(event: EmergencyControlEventRecord): string {
  return digestOf(serializeEmergencyControlEvent(event));
}

export interface EmergencyControlHeadRecord {
  /** The latest event's sequence, or `0` while none exists. */
  readonly eventSequence: number;
  /** How many event rows must exist. The anchor that makes a deleted event detectable without walking the chain. */
  readonly eventCount: number;
  /** The latest event's digest, or the genesis digest. */
  readonly eventDigest: string;
  readonly updatedAt: string;
}

export function serializeEmergencyControlHead(head: EmergencyControlHeadRecord): string {
  return [
    '{',
    [
      `"eventCount":${String(head.eventCount)}`,
      `"eventDigest":${JSON.stringify(head.eventDigest)}`,
      `"eventSequence":${String(head.eventSequence)}`,
      `"format":${JSON.stringify(EMERGENCY_CONTROL_RECORD_FORMAT)}`,
      '"kind":"head"',
      `"schemaVersion":${JSON.stringify(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION)}`,
      `"updatedAt":${JSON.stringify(head.updatedAt)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeEmergencyControlHead`. */
export function emergencyControlHeadDigest(head: EmergencyControlHeadRecord): string {
  return digestOf(serializeEmergencyControlHead(head));
}

export interface StoredEmergencyControl {
  readonly controlKey: string;
  readonly scope: EmergencyControlScope;
  /** Absent for `global`. */
  readonly value?: string;
  readonly active: boolean;
  readonly issuerRef: string;
  readonly declaredAt: string;
  /** The event this projection was produced by. A projection that points nowhere is not a projection. */
  readonly eventSequence: number;
  readonly eventDigest: string;
}

/** The canonical envelope for the current-state projection, including the event it is derived from. */
export function serializeStoredEmergencyControl(control: StoredEmergencyControl): string {
  return [
    '{',
    [
      `"active":${control.active ? 'true' : 'false'}`,
      `"controlKey":${JSON.stringify(control.controlKey)}`,
      `"declaredAt":${JSON.stringify(control.declaredAt)}`,
      `"eventDigest":${JSON.stringify(control.eventDigest)}`,
      `"eventSequence":${String(control.eventSequence)}`,
      `"format":${JSON.stringify(EMERGENCY_CONTROL_RECORD_FORMAT)}`,
      `"issuerRef":${JSON.stringify(control.issuerRef)}`,
      '"kind":"control"',
      `"schemaVersion":${JSON.stringify(EMERGENCY_CONTROL_STORE_SCHEMA_VERSION)}`,
      `"scope":${JSON.stringify(control.scope)}`,
      `"value":${control.value === undefined ? 'null' : JSON.stringify(control.value)}`,
    ].join(','),
    '}',
  ].join('');
}

/** `sha256:<hex>` over `serializeStoredEmergencyControl`. Storage integrity, never a signature. */
export function storedEmergencyControlDigest(control: StoredEmergencyControl): string {
  return digestOf(serializeStoredEmergencyControl(control));
}
