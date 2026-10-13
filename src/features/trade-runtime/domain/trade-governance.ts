import type { ParameterDimensionDeclaration } from '../../governed-parameter-runtime/index.js';
import { tradeAssetToken, tradeDecimalQuantity, tradeMonetaryAssetId } from './trade-asset.js';
import { isTradeIdentifier, isPlainRecord } from './trade-grammar.js';
import { validateTradeProposal, type AcceptedTradeProposal, type TradeProposalViolation } from './trade-proposal.js';

/**
 * How a trading proposal becomes a governed action (TRADE-01).
 *
 * > A trading proposal **compiles down** to the generic governed-action
 * > envelope. It is never a second way in, and it is never a decision.
 *
 * ```
 * TradeProposal                    GovernedActionIntent              governed axis
 * ───────────────────────────────  ────────────────────────────────  ──────────────────────────────────────────
 * (binding.action)              →  action                            Kernel action.type · grant action bound
 * network + ownerAccount        →  resource "<network>:<owner>"      resourceScope · grant resource set
 * takerGets (what the owner     →  amount {value, currency}          P9 amount · P10 ceiling · P7 exposure
 *   gives up), in its unit         currency = "<network>:<asset>"
 * digest of the canonical       →  parameters.tradeProposalDigest    CORE-03 token, exact: the whole proposal
 *   proposal
 * network                       →  parameters.tradeNetwork           CORE-03 token, exact
 * delegateAccount               →  parameters.tradeDelegateAccount   CORE-03 token, exact
 * base / quote asset (derived)  →  parameters.tradeBaseAsset / …     CORE-03 tokens, exact
 * side (derived)                →  parameters.tradeSide              CORE-03 token, exact
 * base quantity (derived)       →  parameters.tradeQuantity          CORE-03 token, exact (decimal text)
 * idempotencyKey                →  idempotencyKey                    request identity, replay / conflict
 * requestId                     →  correlationId
 * organizationId, principalId   →  (checked against the bound identity; never sent)
 * ```
 *
 * ## What binds the exact order
 *
 * `tradeProposalDigest` is declared `exact`, so a grant issued for this
 * request names exactly this digest and nothing else — every economic field,
 * the owner, the delegate, the network, the flags, the expiration and the
 * requested validity are inside it. The other dimensions repeat a few of those
 * values as typed tokens so deterministic policy can *read* them (an approved
 * base asset, a delegate allowlist); none of them can loosen what the digest
 * pins. The limit price is not a parameter: an exact fraction is not a CORE
 * parameter type (see the TRADE-01 doc, policy spike).
 *
 * ## Trust boundaries
 *
 * Everything this function emits is **applicant intent**. It emits no
 * asserted context at all, so a trading engine cannot use compilation to
 * state a reference price, an exposure, a delegation status or any other fact:
 * those reach policy only as facts the Trusted Context Boundary admits (CORE-04),
 * and the ledger's delegation is checked by the execution side at signing time.
 * Organization and principal come from the authenticated identity the caller
 * is bound to; a proposal naming another is refused here, before anything is
 * evaluated, and the orchestrator binds identity again on its own.
 *
 * Pure and deterministic: no network, no signer, no adapter, no clock.
 */

/** The CORE-03 dimension ids a trading proposal states. Declared by a host in `governance.parameterDimensions`; reserved in asserted context by the registry as every declared dimension is. */
export const TRADE_PARAMETER_DIMENSION_IDS = {
  proposalDigest: 'tradeProposalDigest',
  network: 'tradeNetwork',
  delegateAccount: 'tradeDelegateAccount',
  baseAsset: 'tradeBaseAsset',
  quoteAsset: 'tradeQuoteAsset',
  side: 'tradeSide',
  quantity: 'tradeQuantity',
} as const;

/** Every trade dimension is a token bound `exact`: a grant for one order, delegate, pair or quantity is never a grant for another. */
export const TRADE_PARAMETER_DIMENSIONS: readonly ParameterDimensionDeclaration[] = Object.freeze(
  Object.values(TRADE_PARAMETER_DIMENSION_IDS).map((id) => Object.freeze({ id, type: 'token', bound: 'exact' } as const)),
);

/** The parameter list for a trading Governance Profile: all required. */
export const TRADE_PROFILE_PARAMETERS: readonly { readonly dimension: string; readonly required: boolean }[] = Object.freeze(
  Object.values(TRADE_PARAMETER_DIMENSION_IDS).map((dimension) => Object.freeze({ dimension, required: true })),
);

/**
 * Context keys a host should add to its registry's `reservedContextKeys` for
 * a trading deployment: names under which an applicant might otherwise try to
 * *assert* a fact only trusted context may state. Configuration, never CORE's
 * built-in list (which stays free of trading vocabulary).
 */
export const TRADE_RESERVED_CONTEXT_KEYS: readonly string[] = Object.freeze([
  'referencePrice',
  'marketPrice',
  'oraclePrice',
  'priceBand',
  'exposure',
  'openExposure',
  'activeOrders',
  'openOrders',
  'delegation',
  'delegationVerified',
  'delegationProof',
  'ledgerPermission',
  'tradeLimit',
  'tradeTerms',
]);

/** Trusted host configuration: which governed action identifier is an OfferCreate in this deployment. */
export interface TradeGovernanceBinding {
  readonly action: string;
}

/** The authenticated identity a compilation runs for. From the bound session, never from the proposal. */
export interface TradeCompilationIdentity {
  readonly organizationId: string;
  readonly principalId: string;
}

export class TradeConfigurationError extends Error {
  readonly code: 'TRADE_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'TradeConfigurationError';
    this.code = 'TRADE_CONFIGURATION_INVALID';
  }
}

export const TRADE_COMPILATION_REFUSALS = {
  ORGANIZATION_MISMATCH: 'ORGANIZATION_MISMATCH',
  PRINCIPAL_MISMATCH: 'PRINCIPAL_MISMATCH',
  IDENTITY_MALFORMED: 'IDENTITY_MALFORMED',
  ENVELOPE_OPTIONS_INVALID: 'ENVELOPE_OPTIONS_INVALID',
} as const;

export type TradeCompilationRefusal = (typeof TRADE_COMPILATION_REFUSALS)[keyof typeof TRADE_COMPILATION_REFUSALS];

/** A proposal that cannot compile. Carries codes and field names only — never a value. */
export class TradeProposalRefusedError extends Error {
  readonly code: 'TRADE_PROPOSAL_REFUSED';
  readonly violations: readonly (TradeProposalViolation | { readonly code: TradeCompilationRefusal; readonly field: string })[];

  constructor(violations: readonly (TradeProposalViolation | { readonly code: TradeCompilationRefusal; readonly field: string })[]) {
    super(`The trading proposal was refused: ${violations.map((violation) => `${violation.code} (${violation.field})`).join(', ')}.`);
    this.name = 'TradeProposalRefusedError';
    this.code = 'TRADE_PROPOSAL_REFUSED';
    this.violations = Object.freeze([...violations]);
  }
}

/** Builds the frozen binding, or throws `TradeConfigurationError`. Wiring-time. */
export function createTradeGovernanceBinding(configuration: { readonly action: string }): TradeGovernanceBinding {
  const action: unknown = isPlainRecord(configuration) ? configuration['action'] : undefined;
  if (!isTradeIdentifier(action)) throw new TradeConfigurationError('The trade action must be a canonical governed action identifier.');
  return Object.freeze({ action });
}

/**
 * The governed-action intent a trading proposal compiles to — structurally the
 * envelope's own `GovernedActionIntent`, stated here rather than imported
 * because a feature module never depends on the enterprise layer. An
 * enterprise test proves the envelope validator accepts it.
 */
export interface TradeGovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly parameters: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

export interface TradeEnvelopeOptions {
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

export interface TradeCompilation {
  readonly intent: TradeGovernedActionIntent;
  readonly accepted: AcceptedTradeProposal;
}

/** The governed resource for an owner account on a network: `<network>:<owner>`. Injective; a network id never contains `:`. */
export function tradeResourceOf(accepted: AcceptedTradeProposal): string {
  return `${accepted.proposal.network}:${accepted.proposal.ownerAccount}`;
}

function readEnvelope(envelope: unknown): { readonly ok: true; readonly expected?: { readonly id: string; readonly version: number } } | { readonly ok: false } {
  if (envelope === undefined) return { ok: true };
  if (!isPlainRecord(envelope)) return { ok: false };
  const keys = Reflect.ownKeys(envelope);
  if (keys.length === 0) return { ok: true };
  if (keys.length !== 1 || keys[0] !== 'expectedGovernanceProfile') return { ok: false };
  const descriptor = Object.getOwnPropertyDescriptor(envelope, 'expectedGovernanceProfile');
  const pin: unknown = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
  if (!isPlainRecord(pin)) return { ok: false };
  const pinKeys = Reflect.ownKeys(pin);
  if (pinKeys.length !== 2 || !pinKeys.includes('id') || !pinKeys.includes('version')) return { ok: false };
  const id = Object.getOwnPropertyDescriptor(pin, 'id');
  const version = Object.getOwnPropertyDescriptor(pin, 'version');
  if (id === undefined || version === undefined || !('value' in id) || !('value' in version)) return { ok: false };
  if (typeof id.value !== 'string' || typeof version.value !== 'number' || !Number.isSafeInteger(version.value) || Object.is(version.value, -0)) return { ok: false };
  return { ok: true, expected: Object.freeze({ id: id.value, version: version.value }) };
}

/**
 * Compiles a trading proposal to its governed-action intent.
 *
 * The proposal is validated here in full (a canonical proposal validates to
 * itself), checked against the bound identity, and mapped onto the envelope.
 * The same proposal, binding and identity always produce an equal, frozen
 * intent, so its digest — and therefore replay and conflict on the governed
 * path — is a function of the proposal alone. Throws
 * `TradeProposalRefusedError` (codes and fields, never values) or
 * `TradeConfigurationError`; it never repairs.
 */
export function compileTradeProposal(raw: unknown, binding: TradeGovernanceBinding, identity: TradeCompilationIdentity, envelope?: TradeEnvelopeOptions): TradeCompilation {
  const action: unknown = isPlainRecord(binding) ? binding['action'] : undefined;
  if (!isTradeIdentifier(action)) throw new TradeConfigurationError('The trade governance binding is not canonical.');
  const organizationId: unknown = isPlainRecord(identity) ? identity['organizationId'] : undefined;
  const principalId: unknown = isPlainRecord(identity) ? identity['principalId'] : undefined;
  if (!isTradeIdentifier(organizationId) || !isTradeIdentifier(principalId)) throw new TradeProposalRefusedError([{ code: TRADE_COMPILATION_REFUSALS.IDENTITY_MALFORMED, field: '<identity>' }]);

  const validation = validateTradeProposal(raw);
  if (!validation.valid) throw new TradeProposalRefusedError(validation.violations);
  const accepted = validation.accepted;
  const { proposal, terms } = accepted;

  // Cross-organization and cross-principal isolation: the proposal states who
  // it is for, and that must be exactly who is asking.
  const mismatches: { readonly code: TradeCompilationRefusal; readonly field: string }[] = [];
  if (proposal.organizationId !== organizationId) mismatches.push({ code: TRADE_COMPILATION_REFUSALS.ORGANIZATION_MISMATCH, field: 'organizationId' });
  if (proposal.principalId !== principalId) mismatches.push({ code: TRADE_COMPILATION_REFUSALS.PRINCIPAL_MISMATCH, field: 'principalId' });
  if (mismatches.length > 0) throw new TradeProposalRefusedError(mismatches);

  const options = readEnvelope(envelope);
  if (!options.ok) throw new TradeProposalRefusedError([{ code: TRADE_COMPILATION_REFUSALS.ENVELOPE_OPTIONS_INVALID, field: '<envelope>' }]);

  const ids = TRADE_PARAMETER_DIMENSION_IDS;
  const parameters: Record<string, string> = {
    [ids.baseAsset]: tradeAssetToken(terms.base),
    [ids.delegateAccount]: proposal.delegateAccount,
    [ids.network]: proposal.network,
    [ids.proposalDigest]: accepted.digest,
    [ids.quantity]: terms.quantity,
    [ids.quoteAsset]: tradeAssetToken(terms.quote),
    [ids.side]: terms.side,
  };
  const intent: TradeGovernedActionIntent = Object.freeze({
    action,
    resource: tradeResourceOf(accepted),
    amount: Object.freeze({ value: tradeDecimalQuantity(proposal.takerGets), currency: tradeMonetaryAssetId(proposal.network, terms.side === 'sell' ? terms.base : terms.quote) }),
    parameters: Object.freeze(parameters),
    idempotencyKey: proposal.idempotencyKey,
    correlationId: proposal.requestId,
    ...(options.expected !== undefined ? { expectedGovernanceProfile: options.expected } : {}),
  });
  return Object.freeze({ intent, accepted });
}
