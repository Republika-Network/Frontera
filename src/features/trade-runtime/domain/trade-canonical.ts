import { createHash } from 'crypto';

import type { TradeProposal } from './trade-proposal.js';

/**
 * Canonical serialization and the proposal digest (TRADE-01).
 *
 * The digest is computed over the **accepted canonical proposal** — never over
 * the JSON a caller sent — so two spellings of one economic proposal share a
 * digest and two different proposals never do. The serialization is the
 * repository's canonical-JSON discipline: object keys in code-unit order, no
 * whitespace, strings via `JSON.stringify`, safe integers only, arrays in
 * their (already canonical) order.
 *
 * The digest is an **integrity and correlation primitive only**. It is not a
 * signature, not proof of authority and not a grant: anyone can compute it.
 * Authority comes from the governed path, which binds the digest exactly as a
 * typed parameter (see `trade-governance.ts`).
 */

/** Domain separation: the digest of a trade proposal can never be mistaken for the digest of anything else hashed in the same way. */
export const TRADE_PROPOSAL_DIGEST_DOMAIN = 'frontera.trade-proposal-digest.v1';

function canonicalJson(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new RangeError('Only safe integers are canonical numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new RangeError('Not canonical JSON data.');
}

/** The canonical bytes of an accepted proposal. Optional fields that are absent are absent here too — never `null`, never a default. */
export function serializeTradeProposal(proposal: TradeProposal): string {
  return canonicalJson(proposal);
}

/** `sha256:<hex>` over the domain tag and the canonical proposal. */
export function tradeProposalDigest(proposal: TradeProposal): string {
  return `sha256:${createHash('sha256').update(`${TRADE_PROPOSAL_DIGEST_DOMAIN}\n${serializeTradeProposal(proposal)}`).digest('hex')}`;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isTradeProposalDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}
