import type { GovernanceRecord, GovernanceStoreAccessContext, GovernanceStoreQuery, GovernanceStoreQueryResult } from './contracts.js';

/**
 * G-01B1 — the one answer to "did this record come through the governed-action
 * path?", for every consumer that treats a Governance Record as a governed
 * decision (a reconsideration's original, a governed trace, a refund's release
 * basis).
 *
 * The request id proves nothing: an `aoc.gar:` id is a shape, and records
 * committed before G-01B0 — or written directly by an embedder — stand at
 * governed-looking ids without ever having been governed. Neither do integrity
 * or attribution: a planted record verifies, and an advisory record's actor may
 * be merely asserted. What proves governed provenance is the governed-action
 * path's own idempotency claim, which that path writes in the same transaction
 * as the record: the PROD-03-01 `governed-action` predicate
 * (`isGovernedActionIdempotencyClaim`, evaluated by both Store providers —
 * in SQL by the SQLite provider, in `matchesGovernedPath` by the in-memory one).
 *
 * This module adds no second provenance model. It asks the Store's own scoped
 * query for that predicate at the record's request id and requires the answer
 * to be exactly the record in hand — the same evaluation, request id and
 * organization. That turns the `governed-action` query filter into a security
 * boundary (it was introduced as an operator selection filter): a Store whose
 * query cannot answer it, answers it for another evaluation, or fails, leaves
 * the record not governed. Fail closed, never fail open.
 *
 * Records are append-only and the claim commits with its record, so the two
 * reads cannot disagree about a committed record; a Store failure propagates
 * to the caller, which treats it as unavailable.
 */

/** The narrowest reads the resolver needs — both are part of the canonical Governance Store contract. */
export interface GovernedProvenanceReader {
  getByRequestId(context: GovernanceStoreAccessContext, requestId: string): Promise<GovernanceRecord | null>;
  query(context: GovernanceStoreAccessContext, query: GovernanceStoreQuery): Promise<GovernanceStoreQueryResult>;
}

export type GovernedRecordResolution =
  /** No record stands at this request id within the caller's scope. */
  | { readonly kind: 'absent' }
  /** A record stands there, but nothing proves it came through the governed-action path. Never a governed decision. */
  | { readonly kind: 'not-governed'; readonly record: GovernanceRecord }
  | { readonly kind: 'governed'; readonly record: GovernanceRecord };

/**
 * Whether `record` holds the governed-action path's own claim, as the Store's
 * scoped `governed-action` query answers it. Throws only if the Store does.
 */
export async function hasGovernedActionProvenance(reader: Pick<GovernedProvenanceReader, 'query'>, context: GovernanceStoreAccessContext, record: GovernanceRecord): Promise<boolean> {
  const requestId = record.evaluation.requestId;
  const organizationId = record.request.organizationId;
  // The governed path always binds a request to an organization, under one request id.
  if (organizationId === undefined || record.request.requestId !== requestId) return false;
  const result = await reader.query(context, { organizationId, requestId, governedPath: 'governed-action', limit: 1 });
  const records = Array.isArray(result?.records) ? result.records : [];
  if (records.length !== 1) return false;
  const [hit] = records;
  return hit !== undefined && hit.evaluationId === record.evaluation.evaluationId && hit.requestId === requestId && hit.organizationId === organizationId;
}

/** Reads the record at `requestId` in the caller's scope and classifies its provenance. Throws only if the Store does. */
export async function resolveGovernedRecord(reader: GovernedProvenanceReader, context: GovernanceStoreAccessContext, requestId: string): Promise<GovernedRecordResolution> {
  const record = await reader.getByRequestId(context, requestId);
  if (record === null) return { kind: 'absent' };
  if (record.evaluation.requestId !== requestId) return { kind: 'not-governed', record };
  return (await hasGovernedActionProvenance(reader, context, record)) ? { kind: 'governed', record } : { kind: 'not-governed', record };
}
