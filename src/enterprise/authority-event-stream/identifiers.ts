import { computeDigest } from '../governance-store/digest.js';
import type { AuthorityEventType } from './contracts.js';

/**
 * Stream and event identities, derived on the server from identities that
 * already exist in authoritative stores. Nothing here is random, clock-derived
 * or caller-chosen, and nothing here is authority: an id says *which* fact an
 * event reports, never that anything is permitted.
 *
 * Each derivation digests a domain-separated array through the Governance
 * Store's one canonical primitive (`computeDigest`, `aoc.canonical-json.v1`) —
 * no second canonicalization — so no two inputs collide by moving a separator,
 * and a stream id can never equal an event id computed from the same parts.
 */
function derive(parts: readonly string[]): string {
  return computeDigest(parts).slice('sha256:'.length, 'sha256:'.length + 32);
}

/**
 * One governed-action request, in one organization → one stream.
 *
 * The request id is already server-derived (`aoc.gar:`, from the bound
 * organization, the bound principal and the idempotency key), so the trust
 * anchor is never a caller's raw value. The organization is an input as well,
 * so the same request id presented under another tenant is a different stream
 * rather than a way into this one.
 */
export function deriveAuthorityEventStreamId(input: { readonly organizationId: string; readonly requestId: string }): string {
  return `aoc.aes:${derive(['aoc.authority-event-stream.v1', input.organizationId, input.requestId])}`;
}

/**
 * One immutable source fact → one event id.
 *
 * `sourceId` is the identity of the authoritative artifact the fact is about —
 * the evaluation for a committed decision, the grant for its issuance,
 * revocation or expiry, the execution identity for its claim and outcome, the
 * reservation for its admission and terminal event. Re-projecting the same fact
 * (a retry, a replay, a restart) derives the same id, which the store resolves to
 * the event already recorded instead of a second copy.
 */
export function deriveAuthorityEventId(input: { readonly streamId: string; readonly eventType: AuthorityEventType; readonly sourceId: string }): string {
  return `aoc.aev:${derive(['aoc.authority-event.v1', input.streamId, input.eventType, input.sourceId])}`;
}
