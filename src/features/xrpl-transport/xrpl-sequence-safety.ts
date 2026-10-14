import { isPermittedXrplNetworkId } from './xrpl-network-identity.js';

/**
 * Owner-account `Sequence` safety (TRADE-04A).
 *
 * An XRPL account's `Sequence` is a ledger-global fact of that account on one
 * network. Whichever transaction type consumes it — a Payment from a source
 * account, or a delegated OfferCreate whose `Account` is the owner (the
 * delegate signs and pays the fee; the **owner's** `Sequence` is consumed) —
 * two transactions prepared independently for one account can compete for one
 * `Sequence`, and exactly one of them can validate.
 *
 * ## The blocking rule
 *
 * An open earlier submission blocks a candidate `Sequence` S on the same
 * (network, account) exactly when
 *
 * ```
 * window.open
 * and window.lastLedgerSequence > validatedLedgerIndex   (its window is still open)
 * and window.sequence >= S                               (S could take, or precede, its sequence)
 * ```
 *
 * The PAY-03 durable interlock applies this rule (it is the predicate its
 * `blocking` and `reserve` decide with). Releases are ledger facts only.
 *
 * ## One submission domain per sequence account
 *
 * A blocking rule protects only the records it can see. Two submission domains
 * with separate interlocks would each see only their own records — separate
 * rail ids give no safety for one account. So, until one durable, account-scoped
 * sequence authority serves more than one domain (a reviewed migration,
 * ADR-XRPL-SHARED-TRANSPORT §9), every (network, account) whose `Sequence` a
 * domain consumes belongs to **exactly one** domain, and a composition naming
 * the same one twice is refused before anything is opened.
 */

/** One earlier submission's hold on an account's sequence window. */
export interface XrplSequenceWindow {
  readonly sequence: number;
  readonly lastLedgerSequence: number;
  /** `submitting` or `unconfirmed`: not yet closed by a ledger fact. */
  readonly open: boolean;
}

/**
 * Whether `window` blocks candidate sequence `candidate` at validated index
 * `validatedLedgerIndex`. Pure and total, and fail-closed: only an explicit
 * `open: false` (a ledger-fact settlement) releases a record, and a window
 * whose numbers cannot be compared blocks.
 */
export function xrplSequenceWindowBlocks(window: XrplSequenceWindow, candidate: number, validatedLedgerIndex: number): boolean {
  if (window.open === false) return false;
  const comparable = [window.sequence, window.lastLedgerSequence, candidate, validatedLedgerIndex].every((value) => typeof value === 'number' && Number.isSafeInteger(value));
  if (!comparable) return true;
  return window.lastLedgerSequence > validatedLedgerIndex && window.sequence >= candidate;
}

/** A composition that consumes XRPL `Sequence` numbers: the accounts whose sequence its transactions take. */
export interface XrplSequenceDomain {
  /** A recordable identifier: the rail or adapter id. */
  readonly domainId: string;
  readonly networkId: number;
  /** The accounts whose `Sequence` this domain consumes: Payment source accounts; for a delegated transaction, the owner (`Account`), never the delegate. */
  readonly sequenceAccounts: readonly string[];
}

export type XrplSequenceOwnershipProblem = 'XRPL_SEQUENCE_DOMAIN_INVALID' | 'XRPL_SEQUENCE_DOMAIN_DUPLICATE' | 'XRPL_SEQUENCE_ACCOUNT_SHARED';

/** Names the domains and the rule; never an address. */
export class XrplSequenceOwnershipError extends Error {
  readonly code: XrplSequenceOwnershipProblem;

  constructor(code: XrplSequenceOwnershipProblem, message: string) {
    super(message);
    this.name = 'XrplSequenceOwnershipError';
    this.code = code;
  }
}

const DOMAIN_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const CLASSIC_ADDRESS = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;

/** Per (network, account): the one domain that owns its sequence. */
export interface XrplSequenceOwnership {
  readonly domains: readonly string[];
  /** The domain that owns `account`'s sequence on `networkId`, or `undefined`. */
  ownerOf(networkId: number, account: string): string | undefined;
}

/**
 * Verifies that no (network, account) is a sequence account of two domains,
 * and answers the ownership map. Throws `XrplSequenceOwnershipError` — the
 * composition refuses — otherwise. Mainnet domains are accepted only when the
 * domain itself was configured for mainnet (`allowMainnet`), as every XRPL
 * configuration requires.
 */
export function assertXrplSequenceOwnership(domains: readonly XrplSequenceDomain[], options: { readonly allowMainnet?: boolean } = {}): XrplSequenceOwnership {
  if (!Array.isArray(domains)) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_INVALID', 'The XRPL sequence domains must be a list.');
  const owners = new Map<string, string>();
  const seen = new Set<string>();
  for (const [position, domain] of domains.entries()) {
    const domainId: unknown = domain?.domainId;
    if (typeof domainId !== 'string' || !DOMAIN_ID.test(domainId)) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_INVALID', `XRPL sequence domain ${String(position)} has no recordable domain id.`);
    if (seen.has(domainId)) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_DUPLICATE', `XRPL sequence domain '${domainId}' is declared twice.`);
    seen.add(domainId);
    if (!isPermittedXrplNetworkId(domain.networkId, options.allowMainnet === true)) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_INVALID', `XRPL sequence domain '${domainId}' names an unknown or unpermitted network.`);
    const accounts: unknown = domain.sequenceAccounts;
    if (!Array.isArray(accounts) || accounts.length === 0) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_INVALID', `XRPL sequence domain '${domainId}' names no sequence account.`);
    for (const account of accounts as readonly unknown[]) {
      if (typeof account !== 'string' || !CLASSIC_ADDRESS.test(account)) throw new XrplSequenceOwnershipError('XRPL_SEQUENCE_DOMAIN_INVALID', `XRPL sequence domain '${domainId}' names a sequence account that is not a classic address.`);
      const key = `${String(domain.networkId)}:${account}`;
      const owner = owners.get(key);
      if (owner === domainId) continue;
      if (owner !== undefined) {
        throw new XrplSequenceOwnershipError(
          'XRPL_SEQUENCE_ACCOUNT_SHARED',
          `XRPL sequence domains '${owner}' and '${domainId}' both consume one account's Sequence on one network. Separate interlocks cannot see each other's reservations; this composition is refused until one shared account-scoped sequence authority serves both (ADR-XRPL-SHARED-TRANSPORT §9).`,
        );
      }
      owners.set(key, domainId);
    }
  }
  const frozen = new Map(owners);
  return Object.freeze({
    domains: Object.freeze([...seen]),
    ownerOf: (networkId: number, account: string): string | undefined => frozen.get(`${String(networkId)}:${account}`),
  });
}
