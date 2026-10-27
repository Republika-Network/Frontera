import { createHash } from 'node:crypto';

/**
 * AUTH-02 — the identity store's append-only, hash-chained history.
 *
 * Built exactly as CORE-05's approval log: every row is bound to its store
 * and its position, every append extends a chain from a genesis bound to the
 * store's random id and its organization, and the head
 * `{storeId, organizationId, sequence, chainDigest}` is the store's whole
 * committed state. Every read recomputes the chain over every row and refuses
 * a history that does not end at the head.
 *
 * **Signed since AUTH-03.** The head is signed by the deployment's authority
 * key under `frontera:authority-artifact:human-identity-state:v1` (CORE-02,
 * TD-5 narrowed by the founder to exactly this store-state commitment), and is
 * anchored at the CORE-07 witness when freshness is composed — see
 * `sqlite-human-identity-store.ts`.
 *
 * This file is a leaf: pure serialization and hashing.
 */

export const HUMAN_IDENTITY_CHAIN_FORMAT = 'frontera.human-identity-chain.v1';

export type HumanIdentityRecordKind =
  | 'principal_created'
  | 'principal_revoked'
  | 'enrolment_authorized'
  | 'enrolment_revoked'
  | 'credential_registered'
  | 'credential_used'
  | 'credential_counter_anomaly'
  | 'credential_revoked'
  /** AUTH-03: a human decision challenge consumed by a verified, user-verified assertion — the decision evidence, before CORE-05 records the verdict. */
  | 'decision_authorized'
  /** AUTH-03: what CORE-05 did with an authorized decision (recorded, or refused), recorded best-effort after the command. */
  | 'decision_outcome';

export const HUMAN_IDENTITY_RECORD_KINDS: readonly HumanIdentityRecordKind[] = [
  'credential_counter_anomaly',
  'credential_registered',
  'credential_revoked',
  'credential_used',
  'decision_authorized',
  'decision_outcome',
  'enrolment_authorized',
  'enrolment_revoked',
  'principal_created',
  'principal_revoked',
];

export interface HumanIdentityStateCommitment {
  readonly storeId: string;
  readonly organizationId: string;
  readonly sequence: number;
  /** `sha256:<hex>` over every row, in sequence order. */
  readonly chainDigest: string;
}

/** Exactly what one row commits to. `payload` is canonical JSON (sorted keys), so the digest is deterministic. */
export interface HumanIdentityRowContent {
  readonly organizationId: string;
  readonly kind: HumanIdentityRecordKind;
  /** The human the row is about. */
  readonly operatorId: string;
  /** The enrolment or credential the row is about, when it is about one. */
  readonly objectId: string | null;
  readonly payload: string;
  /** Who recorded the row: an administrator's actor reference, the owner (`owner:<credentialId>`), or the ceremony (`webauthn-ceremony`). */
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export interface StoredHumanIdentityRow extends HumanIdentityRowContent {
  readonly sequence: number;
  readonly digest: string;
}

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** Canonical JSON: object keys sorted, no whitespace. Values are JSON data only (strings, finite numbers, booleans, null, arrays, objects). */
export function canonicalJson(value: Json): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError('canonicalJson: non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry: Json) => canonicalJson(entry)).join(',')}]`;
  const record = value as { readonly [key: string]: Json };
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as Json)}`)
    .join(',')}}`;
}

export type { Json as HumanIdentityJson };

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Canonical bytes of one row, bound to its store and its position. */
export function serializeHumanIdentityRow(storeId: string, sequence: number, row: HumanIdentityRowContent): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('A human identity row sequence is a positive integer.');
  return canonicalJson({
    format: HUMAN_IDENTITY_CHAIN_FORMAT,
    storeId,
    sequence,
    organizationId: row.organizationId,
    kind: row.kind,
    operatorId: row.operatorId,
    objectId: row.objectId,
    payload: row.payload,
    recordedBy: row.recordedBy,
    recordedAt: row.recordedAt,
  });
}

export function humanIdentityRowDigest(storeId: string, sequence: number, row: HumanIdentityRowContent): string {
  return sha256(serializeHumanIdentityRow(storeId, sequence, row));
}

export function humanIdentityGenesisDigest(storeId: string, organizationId: string): string {
  return sha256(`${HUMAN_IDENTITY_CHAIN_FORMAT}\ngenesis\n${canonicalJson({ organizationId, storeId })}`);
}

export function nextHumanIdentityChainDigest(previous: string, rowDigest: string): string {
  return sha256(`${HUMAN_IDENTITY_CHAIN_FORMAT}\nlink\n${canonicalJson({ previous, row: rowDigest })}`);
}

/** Canonical bytes of the committed head — what a future signature would cover. */
export function serializeHumanIdentityStateCommitment(state: HumanIdentityStateCommitment): string {
  return canonicalJson({ chainDigest: state.chainDigest, organizationId: state.organizationId, sequence: state.sequence, storeId: state.storeId });
}
