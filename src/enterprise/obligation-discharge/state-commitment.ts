import { createHash } from 'node:crypto';

/**
 * CORE-04 — the signed state of an obligation discharge store.
 *
 * A verified or waived discharge decides whether a withheld decision may be
 * issued a grant, so the discharge log is **authority-material**. An unkeyed
 * digest proves only that rows agree with themselves: a database-only writer
 * can insert a row, choose a configured independent source, recompute the
 * digest and manufacture satisfaction. It can also *delete* a genuine row — and
 * because the obligation lifecycle orders observations by time, removing a
 * self-reported discharge can let a later independent waiver apply that the
 * lifecycle would otherwise refuse. Row-level signatures alone would not catch
 * that; set completeness matters.
 *
 * So the store commits, like CORE-01's revocation state, to its **whole**
 * append-only history: a hash chain from a genesis bound to the store's id and
 * organization, advanced by every row in sequence, whose head
 * `{storeId, organizationId, sequence, chainDigest}` is signed by the
 * deployment's authority key under its own domain. Every authoritative read
 * verifies the signature and recomputes the chain over every row; an inserted,
 * altered, deleted, reordered or transplanted row fails, and so does the store.
 *
 * This file is a leaf: pure serialization and hashing, imported by both the
 * store and the authority-authenticity signing boundary.
 */

export const OBLIGATION_DISCHARGE_CHAIN_FORMAT = 'frontera.obligation-discharge-chain.v1';

export interface ObligationDischargeStateCommitment {
  /** The store's random identity, created with it. Binds every row and the head to this store. */
  readonly storeId: string;
  /** The one organization this store records for. */
  readonly organizationId: string;
  /** How many rows the committed history holds. `0` is the signed genesis. */
  readonly sequence: number;
  /** `sha256:<hex>` — the chain head over every row, in sequence order. */
  readonly chainDigest: string;
}

/** Exactly the fields an obligation discharge row commits to. Everything a read relies on is in here. */
export interface ObligationDischargeRowContent {
  readonly organizationId: string;
  readonly correlation: { readonly requestId: string; readonly action: string; readonly resourceScope: string };
  readonly obligationType: string;
  readonly sourceId: string;
  readonly outcome: string;
  readonly observedAt: string;
  readonly reference?: string;
  readonly subjectId?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

const quote = (value: string): string => JSON.stringify(value);

/** Canonical bytes of one row, bound to its store and its position. Keys fixed and sorted; absent optional fields omitted. */
export function serializeObligationDischargeRow(storeId: string, sequence: number, row: ObligationDischargeRowContent): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError('A discharge row sequence is a positive integer.');
  return [
    '{',
    [
      `"action":${quote(row.correlation.action)}`,
      `"format":${quote(OBLIGATION_DISCHARGE_CHAIN_FORMAT)}`,
      `"obligationType":${quote(row.obligationType)}`,
      `"observedAt":${quote(row.observedAt)}`,
      `"organizationId":${quote(row.organizationId)}`,
      `"outcome":${quote(row.outcome)}`,
      `"recordedAt":${quote(row.recordedAt)}`,
      `"recordedBy":${quote(row.recordedBy)}`,
      ...(row.reference !== undefined ? [`"reference":${quote(row.reference)}`] : []),
      `"requestId":${quote(row.correlation.requestId)}`,
      `"resourceScope":${quote(row.correlation.resourceScope)}`,
      `"sequence":${String(sequence)}`,
      `"sourceId":${quote(row.sourceId)}`,
      `"storeId":${quote(storeId)}`,
      ...(row.subjectId !== undefined ? [`"subjectId":${quote(row.subjectId)}`] : []),
    ].join(','),
    '}',
  ].join('');
}

export function obligationDischargeRowDigest(storeId: string, sequence: number, row: ObligationDischargeRowContent): string {
  return sha256(serializeObligationDischargeRow(storeId, sequence, row));
}

/** The chain head before any row: bound to the store and the organization, so no other store's history can start here. */
export function obligationDischargeGenesisDigest(storeId: string, organizationId: string): string {
  return sha256(`${OBLIGATION_DISCHARGE_CHAIN_FORMAT}\ngenesis\n{"organizationId":${quote(organizationId)},"storeId":${quote(storeId)}}`);
}

/** The chain head after appending one row whose digest is `rowDigest`. */
export function nextObligationDischargeChainDigest(previous: string, rowDigest: string): string {
  return sha256(`${OBLIGATION_DISCHARGE_CHAIN_FORMAT}\nlink\n{"previous":${quote(previous)},"row":${quote(rowDigest)}}`);
}

/** Canonical bytes of the committed head — what the authority key signs. */
export function serializeObligationDischargeStateCommitment(state: ObligationDischargeStateCommitment): string {
  return `{"chainDigest":${quote(state.chainDigest)},"organizationId":${quote(state.organizationId)},"sequence":${String(state.sequence)},"storeId":${quote(state.storeId)}}`;
}
