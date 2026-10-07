import { createHash } from 'node:crypto';

import type { GovernanceRecord } from '../governance-store/contracts.js';
import { deriveBusinessIntentId, reconsiderationLinkReferenceId } from './identifiers.js';

/**
 * Linked reconsideration (LAND-01) — the pure half: vocabulary, the
 * business-intent digest, and the assessment of an already-read original.
 * No store, no write, no clock. The reads happen in `decision-commit.ts` (the
 * one place a committed record is verified) and the two evidence rows are
 * written by `execution-ledger.ts` (the one place evidence is written).
 *
 * A governed action that was withheld can be **explicitly reconsidered** after
 * the governance state it depended on changed. The reconsideration is a fresh
 * governed request — its own idempotency key, its own request id, its own
 * Kernel evaluation, its own committed decision — that names the original by
 * its request id and proves it is the **same business intent**:
 *
 * ```
 * original request (denied/indeterminate)        committed, immutable, never written to
 *   ▲  reconsideration_link row (on the NEW evaluation): original request id,
 *   │  original decision id, business-intent digest, reason
 * reconsideration ── fresh idempotency ── fresh Kernel evaluation ── fresh decision
 *   └─ allowed → realization marker (unique per original) → the normal grant path
 * ```
 *
 * - **Replay is untouched.** Replaying the original idempotency key returns the
 *   original committed decision; it never re-evaluates. A reconsideration is
 *   reached only through a different key and an explicit `reconsideration`.
 * - **Nothing is inherited.** The original's decision is never reused or
 *   upgraded; the reconsideration's decision is the Kernel's, from current
 *   governance state, through the unchanged policy, authority, ceiling,
 *   emergency-control and issuance path. A link row is evidence, never
 *   authority.
 * - **Approval is never implied.** Nothing here reads an approval store or
 *   approves anything; whatever governance state changed is a trusted fact
 *   the fresh evaluation reads like any other.
 * - **One business intent, at most one realization.** The first
 *   reconsideration whose fresh decision proceeds to authority claims a marker
 *   derived from the original request id; the Governance Store refuses a second
 *   one, so another reconsideration of the same original is withheld before
 *   any grant. A retry of the realizing reconsideration finds its own claim.
 *   The marker is an exclusive *right to realize*, taken before issuance so
 *   two grants can never exist for one original: if a later gate (issuance,
 *   exercise) withholds, the holder retries under its own idempotency key and
 *   meets those gates again; no other reconsideration can take its place.
 * - **Only Kernel-withheld originals.** An original whose decision was
 *   allowed (or awaits approval) is not reconsiderable: its committed decision
 *   still stands, and retrying its own idempotency key re-runs every gate
 *   after the decision. A second path to the same intent would bypass the
 *   one realization marker.
 */

/** Why the caller says governance state changed. A closed vocabulary — recorded, never trusted to decide. */
export const RECONSIDERATION_REASONS = ['destination-approved', 'authority-changed', 'policy-changed', 'context-changed'] as const;
export type ReconsiderationReason = (typeof RECONSIDERATION_REASONS)[number];

export function isReconsiderationReason(value: unknown): value is ReconsiderationReason {
  return typeof value === 'string' && (RECONSIDERATION_REASONS as readonly string[]).includes(value);
}

/** The intent field: which original, and why now. */
export interface ReconsiderationIntent {
  /** The original governed request id (`aoc.gar:…`), as its own result returned it. */
  readonly of: string;
  readonly reason: ReconsiderationReason;
}

/** Original decision statuses a reconsideration may follow: only outcomes that withheld the action before any authority. */
const RECONSIDERABLE_STATUSES: ReadonlySet<string> = new Set(['denied', 'indeterminate']);

export type ReconsiderationRefusal =
  | 'RECONSIDERATION_TARGET_SELF'
  | 'RECONSIDERATION_TARGET_NOT_FOUND'
  | 'RECONSIDERATION_TARGET_UNVERIFIABLE'
  | 'RECONSIDERATION_TARGET_OTHER_ACTOR'
  | 'RECONSIDERATION_TARGET_NOT_ORIGINAL'
  | 'RECONSIDERATION_TARGET_NOT_WITHHELD'
  | 'RECONSIDERATION_INTENT_MISMATCH';

export interface VerifiedReconsiderationTarget {
  readonly originalRequestId: string;
  readonly originalDecisionId: string;
  readonly originalEvaluationId: string;
  readonly originalStatus: string;
  readonly businessIntentId: string;
  /** Digest of the business intent both requests carry — proven equal before evaluation. */
  readonly intentDigest: string;
  readonly reason: ReconsiderationReason;
}

export type ReconsiderationAssessment = { readonly ok: true; readonly target: VerifiedReconsiderationTarget } | { readonly ok: false; readonly refusal: ReconsiderationRefusal };

/** Sorted-key JSON: the same value always serializes to the same text, whatever order its keys were built or parsed in. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * The business intent of one persisted request projection: who (organization,
 * actor) wants what (the whole canonical action — type, resource,
 * counterparty, amount, asset, governed semantics and parameters). Excludes
 * the request id, times, the correlation label and asserted context: those
 * describe an attempt, not the intent. Computed over the Governance Store's
 * own request projection, so the original's persisted payload and a new
 * request projected the same way compare exactly.
 */
export function businessIntentDigest(requestPayload: Readonly<Record<string, unknown>>): string {
  const organization = requestPayload['organization'] as { readonly id?: unknown } | undefined;
  const actor = requestPayload['actor'] as { readonly id?: unknown } | undefined;
  const intent = { v: 'aoc.governed-action.business-intent-digest.v1', organizationId: organization?.id ?? null, actorId: actor?.id ?? null, action: requestPayload['action'] ?? null };
  return `sha256:${createHash('sha256').update(canonicalJson(intent), 'utf8').digest('hex')}`;
}

/** True when this record is itself a reconsideration (it carries its own link row). */
export function isReconsiderationRecord(record: GovernanceRecord): boolean {
  return record.references.some((entry) => entry.referenceType === 'reconsideration_link' && entry.referenceId === reconsiderationLinkReferenceId(record.request.requestId));
}

/** `uri` of a link row: the reason, in a fixed URN form. */
export function reconsiderationLinkUri(reason: ReconsiderationReason): string {
  return `urn:aoc:reconsideration:reason:${reason}`;
}

export const RECONSIDERATION_REALIZED_URI = 'urn:aoc:reconsideration:realized';

/**
 * Decide, from the original's committed record (already read and verified by
 * the commit phase) and the new request's projection, whether this caller may
 * reconsider it. Pure.
 */
export function assessReconsiderationTarget(input: {
  readonly original: GovernanceRecord | null;
  readonly originalVerified: boolean;
  readonly scope: { readonly organizationId: string; readonly actorId: string };
  readonly requestId: string;
  readonly reconsideration: ReconsiderationIntent;
  /** The new request, projected exactly as the Governance Store projects requests. */
  readonly requestPayload: Readonly<Record<string, unknown>>;
}): ReconsiderationAssessment {
  const { original, scope, requestId, reconsideration } = input;
  if (reconsideration.of === requestId) return { ok: false, refusal: 'RECONSIDERATION_TARGET_SELF' };
  // Tenant-scoped read upstream: another organization's request is simply not found.
  if (original === null || original.request.requestId !== reconsideration.of || original.request.organizationId !== scope.organizationId) return { ok: false, refusal: 'RECONSIDERATION_TARGET_NOT_FOUND' };
  if (!input.originalVerified) return { ok: false, refusal: 'RECONSIDERATION_TARGET_UNVERIFIABLE' };
  if (original.request.actorId !== scope.actorId) return { ok: false, refusal: 'RECONSIDERATION_TARGET_OTHER_ACTOR' };
  // Only an original may be reconsidered: a lineage has one root, so no chain and no cycle can form.
  if (isReconsiderationRecord(original)) return { ok: false, refusal: 'RECONSIDERATION_TARGET_NOT_ORIGINAL' };
  if (!RECONSIDERABLE_STATUSES.has(original.evaluation.status)) return { ok: false, refusal: 'RECONSIDERATION_TARGET_NOT_WITHHELD' };
  const intentDigest = businessIntentDigest(original.request.requestPayload);
  if (businessIntentDigest(input.requestPayload) !== intentDigest) return { ok: false, refusal: 'RECONSIDERATION_INTENT_MISMATCH' };
  return {
    ok: true,
    target: Object.freeze({
      originalRequestId: original.request.requestId,
      originalDecisionId: original.evaluation.decisionId,
      originalEvaluationId: original.evaluation.evaluationId,
      originalStatus: original.evaluation.status,
      businessIntentId: deriveBusinessIntentId({ organizationId: scope.organizationId, originalRequestId: original.request.requestId }),
      intentDigest,
      reason: reconsideration.reason,
    }),
  };
}
