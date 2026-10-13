import { createHash } from 'node:crypto';

import { canonicalTradeJson, isTradeProposalDigest } from './trade-canonical.js';
import {
  TRADE_DELEGATION_MAXIMUM_AGE_SECONDS,
  TRADE_DELEGATION_REFUSAL_CODES,
  TRADE_DELEGATION_REQUIRED_PERMISSION,
  TRADE_DELEGATION_TOLERATED_PERMISSIONS,
  isTradeInstant,
  parseTradeDelegationObservation,
  verifyTradeDelegation,
} from './trade-delegation.js';
import type { TradeDelegationObservation, TradeDelegationRefusalCode } from './trade-delegation.js';
import {
  TRADE_NETWORKS,
  checkTradeAccountAddress,
  isPlainRecord,
  isSecretShapedPropertyName,
  isTradeIdentifier,
  isTradeNetwork,
  reportablePropertyName,
  snapshotTradeRecord,
} from './trade-grammar.js';
import type { TradeNetwork } from './trade-grammar.js';
import type { TradeProposal } from './trade-proposal.js';

/**
 * Delegation assessment for governed trading (TRADE-02).
 *
 * `trade-delegation.ts` says whether one observation proves one delegation.
 * This module wraps that in the contract a governed path consumes:
 *
 * - **a request** — closed, applicant-shaped, and unable to carry anything
 *   but *which* delegation to check: organization, proposal digest, network,
 *   owner, delegate and the `OfferCreate` permission. It can never state a
 *   verdict, ledger evidence, a source, an endpoint or a freshness bound;
 * - **a policy** — trusted configuration: which source the observation comes
 *   from and how old it may be. The applicant never sees it;
 * - **an assessment** — exactly one of `AUTHORIZED`, `NOT_AUTHORIZED` and
 *   `UNAVAILABLE`, with the objective ledger facts kept apart from Frontera's
 *   derived verdict, and two digests: one over the facts alone (stable however
 *   often the same ledger state is re-read) and one over the whole record.
 *
 * `AUTHORIZED` means the required XLS-75 permission was observed under the
 * policy. It is **not** a governance decision, a grant or a permission to
 * sign: the governed path decides, and the execution side re-reads the ledger
 * immediately before signing. `NOT_AUTHORIZED` and `UNAVAILABLE` are kept
 * apart in the record, and neither is ever a positive answer.
 *
 * The digests are integrity and correlation primitives only — anyone can
 * compute them. They are not signatures and do not prove that a trusted
 * reader produced the record; that comes from the record being produced
 * in-process by the composed verifier and never accepted from an applicant.
 *
 * Pure: no I/O, no clock (instants are passed in), no randomness.
 */

export const TRADE_DELEGATION_REQUEST_SCHEMA = 'frontera.trade-delegation-request.v1';
export const TRADE_DELEGATION_ASSESSMENT_SCHEMA = 'frontera.trade-delegation-assessment.v1';
/** Domain separation for the two digests. */
export const TRADE_DELEGATION_FACTS_DIGEST_DOMAIN = 'frontera.trade-delegation-facts-digest.v1';
export const TRADE_DELEGATION_ASSESSMENT_DIGEST_DOMAIN = 'frontera.trade-delegation-assessment-digest.v1';

// ── Request ──────────────────────────────────────────────────────────────────

/** Which delegation to check. Field names follow the TRADE-01 proposal. */
export interface TradeDelegationVerificationRequest {
  readonly schema: typeof TRADE_DELEGATION_REQUEST_SCHEMA;
  readonly organizationId: string;
  /** The accepted proposal this check is for (`tradeProposalDigest`). Correlation only. */
  readonly proposalDigest: string;
  readonly network: TradeNetwork;
  readonly ownerAccount: string;
  readonly delegateAccount: string;
  readonly permission: typeof TRADE_DELEGATION_REQUIRED_PERMISSION;
}

const REQUEST_FIELDS = ['schema', 'organizationId', 'proposalDigest', 'network', 'ownerAccount', 'delegateAccount', 'permission'] as const;
const REQUEST_MAXIMUM_PROPERTIES = 16;

export const TRADE_DELEGATION_REQUEST_VIOLATIONS = Object.freeze({
  NOT_A_RECORD: 'DELEGATION_REQUEST_NOT_A_RECORD',
  UNDECLARED_PROPERTY: 'DELEGATION_REQUEST_UNDECLARED_PROPERTY',
  SECRET_PROPERTY_REFUSED: 'DELEGATION_REQUEST_SECRET_PROPERTY_REFUSED',
  RAW_TRANSACTION_REFUSED: 'DELEGATION_REQUEST_RAW_TRANSACTION_REFUSED',
  TRUSTED_FACT_CLAIM_REFUSED: 'DELEGATION_REQUEST_TRUSTED_FACT_CLAIM_REFUSED',
  SOURCE_SELECTION_REFUSED: 'DELEGATION_REQUEST_SOURCE_SELECTION_REFUSED',
  MISSING_FIELD: 'DELEGATION_REQUEST_MISSING_FIELD',
  SCHEMA_UNSUPPORTED: 'DELEGATION_REQUEST_SCHEMA_UNSUPPORTED',
  IDENTIFIER_MALFORMED: 'DELEGATION_REQUEST_IDENTIFIER_MALFORMED',
  PROPOSAL_DIGEST_MALFORMED: 'DELEGATION_REQUEST_PROPOSAL_DIGEST_MALFORMED',
  NETWORK_UNSUPPORTED: 'DELEGATION_REQUEST_NETWORK_UNSUPPORTED',
  ACCOUNT_RESERVED: 'DELEGATION_REQUEST_ACCOUNT_RESERVED',
  ACCOUNT_MALFORMED: 'DELEGATION_REQUEST_ACCOUNT_MALFORMED',
  OWNER_IS_DELEGATE: 'DELEGATION_REQUEST_OWNER_IS_DELEGATE',
  PERMISSION_UNSUPPORTED: 'DELEGATION_REQUEST_PERMISSION_UNSUPPORTED',
} as const);

export type TradeDelegationRequestViolationCode = (typeof TRADE_DELEGATION_REQUEST_VIOLATIONS)[keyof typeof TRADE_DELEGATION_REQUEST_VIOLATIONS];

export type TradeDelegationRequestParse =
  | { readonly valid: true; readonly request: TradeDelegationVerificationRequest }
  | { readonly valid: false; readonly violation: TradeDelegationRequestViolationCode; readonly field: string };

const RQ = TRADE_DELEGATION_REQUEST_VIOLATIONS;

/** Raw-transaction spellings: a request names a delegation, never a transaction. Lower-cased. */
const RAW_TRANSACTION = new Set(['transactiontype', 'tx_json', 'tx_blob', 'txjson', 'txblob', 'transaction', 'rawtransaction', 'signedtransaction', 'account', 'authorize', 'permissions', 'delegate', 'signature', 'hash']);
/** Names that claim the answer — or evidence for it — instead of asking for it. */
const TRUSTED_FACT_CLAIM = /(delegation|verified|verdict|proof|attest|evidence|observation|observed|granted|grant|authori[sz]ed|approved|approval|decision|trusted|ledger|validated|status|result|outcome)/i;
/** Names that would let the applicant choose where or how strictly the ledger is read. */
const SOURCE_SELECTION = /(endpoint|url|uri|host|server|node|rpc|source|reader|port|maxage|freshness|age|policy|timeout|minimum|pin)/i;

function classifyUndeclaredRequestField(name: string): TradeDelegationRequestViolationCode {
  if (isSecretShapedPropertyName(name)) return RQ.SECRET_PROPERTY_REFUSED;
  if (RAW_TRANSACTION.has(name.toLowerCase())) return RQ.RAW_TRANSACTION_REFUSED;
  if (TRUSTED_FACT_CLAIM.test(name)) return RQ.TRUSTED_FACT_CLAIM_REFUSED;
  if (SOURCE_SELECTION.test(name)) return RQ.SOURCE_SELECTION_REFUSED;
  return RQ.UNDECLARED_PROPERTY;
}

/**
 * Validates untrusted data as a delegation verification request: exactly the
 * seven declared fields, read once as data. The first violation is returned;
 * an undeclared field is classified (secret, raw transaction, trusted-fact
 * claim, source selection) so a refusal says what was attempted. Values of
 * refused fields are never read.
 */
export function parseTradeDelegationRequest(raw: unknown): TradeDelegationRequestParse {
  const refuse = (violation: TradeDelegationRequestViolationCode, field: string): TradeDelegationRequestParse => Object.freeze({ valid: false as const, violation, field });
  const snapshot = snapshotTradeRecord(raw, REQUEST_MAXIMUM_PROPERTIES);
  if (!snapshot.ok) return refuse(RQ.NOT_A_RECORD, snapshot.property !== undefined ? reportablePropertyName(snapshot.property) : '<request>');
  const entries = snapshot.entries;
  for (const key of entries.keys()) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) return refuse(classifyUndeclaredRequestField(key), reportablePropertyName(key));
  }
  for (const field of REQUEST_FIELDS) if (!entries.has(field)) return refuse(RQ.MISSING_FIELD, field);
  if (entries.get('schema') !== TRADE_DELEGATION_REQUEST_SCHEMA) return refuse(RQ.SCHEMA_UNSUPPORTED, 'schema');
  if (!isTradeIdentifier(entries.get('organizationId'))) return refuse(RQ.IDENTIFIER_MALFORMED, 'organizationId');
  if (!isTradeProposalDigest(entries.get('proposalDigest'))) return refuse(RQ.PROPOSAL_DIGEST_MALFORMED, 'proposalDigest');
  const network = entries.get('network');
  if (!isTradeNetwork(network)) return refuse(RQ.NETWORK_UNSUPPORTED, 'network');
  for (const field of ['ownerAccount', 'delegateAccount'] as const) {
    const check = checkTradeAccountAddress(entries.get(field));
    if (check === 'reserved') return refuse(RQ.ACCOUNT_RESERVED, field);
    if (check !== 'valid') return refuse(RQ.ACCOUNT_MALFORMED, field);
  }
  if (entries.get('ownerAccount') === entries.get('delegateAccount')) return refuse(RQ.OWNER_IS_DELEGATE, 'delegateAccount');
  if (entries.get('permission') !== TRADE_DELEGATION_REQUIRED_PERMISSION) return refuse(RQ.PERMISSION_UNSUPPORTED, 'permission');
  return Object.freeze({
    valid: true as const,
    request: Object.freeze({
      schema: TRADE_DELEGATION_REQUEST_SCHEMA,
      organizationId: entries.get('organizationId') as string,
      proposalDigest: entries.get('proposalDigest') as string,
      network,
      ownerAccount: entries.get('ownerAccount') as string,
      delegateAccount: entries.get('delegateAccount') as string,
      permission: TRADE_DELEGATION_REQUIRED_PERMISSION,
    }),
  });
}

/** The request for an accepted proposal: the delegation it relies on, correlated by its digest. */
export function tradeDelegationRequestFor(proposal: TradeProposal, proposalDigest: string): TradeDelegationRequestParse {
  return parseTradeDelegationRequest({
    schema: TRADE_DELEGATION_REQUEST_SCHEMA,
    organizationId: proposal.organizationId,
    proposalDigest,
    network: proposal.network,
    ownerAccount: proposal.ownerAccount,
    delegateAccount: proposal.delegateAccount,
    permission: proposal.permission,
  });
}

// ── Policy (trusted configuration) ───────────────────────────────────────────

export interface TradeDelegationPolicy {
  /** The configured reader the observation comes from, recorded in the evidence. An identifier, never an endpoint. */
  readonly sourceId: string;
  /** How old an observation may be when it is assessed, 1 to `TRADE_DELEGATION_MAXIMUM_AGE_SECONDS`. */
  readonly maxAgeSeconds: number;
}

/** Validates trusted configuration as a policy; `undefined` for anything else. Refused, never clamped. */
export function parseTradeDelegationPolicy(raw: unknown): TradeDelegationPolicy | undefined {
  const snapshot = snapshotTradeRecord(raw, 2);
  if (!snapshot.ok || snapshot.entries.size !== 2) return undefined;
  const sourceId = snapshot.entries.get('sourceId');
  const maxAgeSeconds = snapshot.entries.get('maxAgeSeconds');
  if (!isTradeIdentifier(sourceId)) return undefined;
  if (typeof maxAgeSeconds !== 'number' || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > TRADE_DELEGATION_MAXIMUM_AGE_SECONDS) return undefined;
  return Object.freeze({ sourceId, maxAgeSeconds });
}

// ── Assessment ───────────────────────────────────────────────────────────────

export type TradeDelegationAssessmentStatus = 'AUTHORIZED' | 'NOT_AUTHORIZED' | 'UNAVAILABLE';

export const TRADE_DELEGATION_ASSESSMENT_REASONS = Object.freeze({
  VERIFIED: 'DELEGATION_VERIFIED',
  REQUEST_REJECTED: 'DELEGATION_REQUEST_REJECTED',
  SOURCE_UNAVAILABLE: 'DELEGATION_SOURCE_UNAVAILABLE',
  CONTEXT_INVALID: 'DELEGATION_CONTEXT_INVALID',
  ...TRADE_DELEGATION_REFUSAL_CODES,
} as const);

export type TradeDelegationAssessmentReason = (typeof TRADE_DELEGATION_ASSESSMENT_REASONS)[keyof typeof TRADE_DELEGATION_ASSESSMENT_REASONS];

/**
 * Which verifier refusals are a *proof* of no delegation. Only these come
 * from a fresh, validated, correctly bound observation of the entry itself;
 * every other refusal means the observation cannot answer the question, and
 * is `UNAVAILABLE`.
 */
const PROVES_NOT_AUTHORIZED: ReadonlySet<TradeDelegationRefusalCode> = new Set([
  TRADE_DELEGATION_REFUSAL_CODES.ABSENT,
  TRADE_DELEGATION_REFUSAL_CODES.CHANGED,
  TRADE_DELEGATION_REFUSAL_CODES.PERMISSION_MISSING,
  TRADE_DELEGATION_REFUSAL_CODES.PERMISSION_EXCESS,
]);

/** What the read-only reader returned. The XRPL rail's `XrplDelegationRead` has this shape. */
export type TradeDelegationReadOutcome =
  | { readonly outcome: 'observed'; readonly observation: TradeDelegationObservation }
  | { readonly outcome: 'unavailable'; readonly failure: string };

/** Pins only the trusted execution side holds (see `TradeDelegationRequirement`). Never from the applicant. */
export interface TradeDelegationPins {
  readonly minimumValidatedLedgerIndex?: number;
  readonly expectedPreviousTxnId?: string;
}

/** Objective facts read from one validated ledger. Never Frontera's opinion. */
export interface TradeDelegationLedgerFacts {
  readonly network: TradeNetwork;
  readonly networkId: number;
  readonly owner: string;
  readonly delegate: string;
  readonly entryIndex: string;
  readonly validatedLedgerIndex: number;
  readonly validatedLedgerHash: string;
  readonly state: 'granted' | 'absent';
  /** Present when granted: every permission the entry carries, canonical and sorted. */
  readonly permissions?: readonly string[];
  readonly previousTxnId?: string;
  readonly previousTxnLedgerIndex?: number;
}

/**
 * Two separate readings of the facts: the protocol fact (does the entry carry
 * `OfferCreate`?) and the application policy (does it carry nothing beyond the
 * trading permissions?). Only both together can be `AUTHORIZED`.
 */
export interface TradeDelegationPermissionReading {
  readonly offerCreateGranted: boolean;
  readonly withinTradingScope: boolean;
}

export interface TradeDelegationAssessment {
  readonly schema: typeof TRADE_DELEGATION_ASSESSMENT_SCHEMA;
  readonly status: TradeDelegationAssessmentStatus;
  readonly reason: TradeDelegationAssessmentReason;
  /** The accepted request; absent when the request itself was rejected. */
  readonly request?: TradeDelegationVerificationRequest;
  /** Why the request was rejected. */
  readonly requestViolation?: TradeDelegationRequestViolationCode;
  readonly source: { readonly sourceId: string };
  /** Present when an observation was obtained for exactly the requested network, owner and delegate. */
  readonly facts?: TradeDelegationLedgerFacts;
  readonly factsDigest?: string;
  readonly permissionReading?: TradeDelegationPermissionReading;
  /** Local observation metadata: when the reader began, when this was assessed, and the bound applied. */
  readonly timing?: { readonly observedAt: string; readonly assessedAt: string; readonly maxAgeSeconds: number };
  /** `sha256:` over everything above, canonically. */
  readonly digest: string;
  /** Transport diagnostics: the reader's failure code. Not covered by the digest; never an error message. */
  readonly diagnostic?: { readonly readFailure: string };
}

export interface TradeDelegationAssessmentInput {
  /** The raw request, as the applicant side shaped it. Parsed here. */
  readonly request: unknown;
  /** The trusted policy, already validated by `parseTradeDelegationPolicy`. */
  readonly policy: TradeDelegationPolicy;
  /** What the configured reader returned for this request — never anything an applicant supplied. */
  readonly read: TradeDelegationReadOutcome | undefined;
  /** The instant of assessment, from the trusted clock. */
  readonly assessedAt: string;
  readonly pins?: TradeDelegationPins;
}

const READ_FAILURE = /^[A-Z][A-Z0-9_]{0,63}$/;

function digestOf(domain: string, value: unknown): string {
  return `sha256:${createHash('sha256').update(`${domain}\n${canonicalTradeJson(value)}`).digest('hex')}`;
}

function factsOf(observation: TradeDelegationObservation): TradeDelegationLedgerFacts {
  const base = {
    network: observation.network,
    networkId: observation.networkId,
    owner: observation.owner,
    delegate: observation.delegate,
    entryIndex: observation.entryIndex,
    validatedLedgerIndex: observation.validatedLedgerIndex,
    validatedLedgerHash: observation.validatedLedgerHash,
  };
  if (observation.state === 'absent') return Object.freeze({ ...base, state: 'absent' as const });
  return Object.freeze({
    ...base,
    state: 'granted' as const,
    permissions: observation.permissions,
    previousTxnId: observation.previousTxnId,
    previousTxnLedgerIndex: observation.previousTxnLedgerIndex,
  });
}

function permissionReadingOf(facts: TradeDelegationLedgerFacts): TradeDelegationPermissionReading {
  const permissions = facts.permissions ?? [];
  return Object.freeze({
    offerCreateGranted: permissions.includes(TRADE_DELEGATION_REQUIRED_PERMISSION),
    withinTradingScope: permissions.length > 0 && permissions.every((permission) => TRADE_DELEGATION_TOLERATED_PERMISSIONS.includes(permission)),
  });
}

/** The digested body of an assessment: everything but `digest` and `diagnostic`, absent fields absent. */
function bodyOf(assessment: Omit<TradeDelegationAssessment, 'digest' | 'diagnostic'>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assessment)) if (value !== undefined && key !== 'digest' && key !== 'diagnostic') body[key] = value;
  return body;
}

function seal(body: Omit<TradeDelegationAssessment, 'digest' | 'diagnostic'>, readFailure?: string): TradeDelegationAssessment {
  const clean = bodyOf(body);
  const digest = digestOf(TRADE_DELEGATION_ASSESSMENT_DIGEST_DOMAIN, clean);
  return Object.freeze({ ...(clean as unknown as Omit<TradeDelegationAssessment, 'digest'>), digest, ...(readFailure !== undefined ? { diagnostic: Object.freeze({ readFailure }) } : {}) });
}

function isValidPins(pins: TradeDelegationPins | undefined): boolean {
  if (pins === undefined) return true;
  const snapshot = snapshotTradeRecord(pins, 2);
  if (!snapshot.ok) return false;
  return [...snapshot.entries.keys()].every((key) => key === 'minimumValidatedLedgerIndex' || key === 'expectedPreviousTxnId');
}

/**
 * Assesses one request against what the reader returned, under the trusted
 * policy, at `assessedAt`. Total: every input yields exactly one sealed
 * assessment, and nothing but a fresh, validated, correctly bound observation
 * granting `OfferCreate` within the trading scope yields `AUTHORIZED`.
 */
export function assessTradeDelegation(input: TradeDelegationAssessmentInput): TradeDelegationAssessment {
  const policy = parseTradeDelegationPolicy(input.policy);
  const sourceId = policy?.sourceId ?? 'unconfigured';
  const source = Object.freeze({ sourceId });
  const parsed = parseTradeDelegationRequest(input.request);
  if (!parsed.valid) {
    return seal({ schema: TRADE_DELEGATION_ASSESSMENT_SCHEMA, status: 'UNAVAILABLE', reason: TRADE_DELEGATION_ASSESSMENT_REASONS.REQUEST_REJECTED, requestViolation: parsed.violation, source });
  }
  const request = parsed.request;
  const unavailable = (reason: TradeDelegationAssessmentReason, readFailure?: string): TradeDelegationAssessment =>
    seal({ schema: TRADE_DELEGATION_ASSESSMENT_SCHEMA, status: 'UNAVAILABLE', reason, request, source }, readFailure);

  if (policy === undefined || !isTradeInstant(input.assessedAt) || !isValidPins(input.pins)) return unavailable(TRADE_DELEGATION_ASSESSMENT_REASONS.CONTEXT_INVALID);
  const read = input.read;
  if (!isPlainRecord(read)) return unavailable(TRADE_DELEGATION_ASSESSMENT_REASONS.SOURCE_UNAVAILABLE);
  if (read.outcome !== 'observed') {
    const failure = read.outcome === 'unavailable' && typeof read.failure === 'string' && READ_FAILURE.test(read.failure) ? read.failure : 'UNRECOGNISED';
    return unavailable(TRADE_DELEGATION_ASSESSMENT_REASONS.SOURCE_UNAVAILABLE, failure);
  }

  const verification = verifyTradeDelegation(read.observation, {
    network: request.network,
    owner: request.ownerAccount,
    delegate: request.delegateAccount,
    at: input.assessedAt,
    maxAgeSeconds: policy.maxAgeSeconds,
    ...(input.pins?.minimumValidatedLedgerIndex !== undefined ? { minimumValidatedLedgerIndex: input.pins.minimumValidatedLedgerIndex } : {}),
    ...(input.pins?.expectedPreviousTxnId !== undefined ? { expectedPreviousTxnId: input.pins.expectedPreviousTxnId } : {}),
  });

  // Facts are recorded only for an intact observation of exactly the requested pair on the requested network.
  const observation = parseTradeDelegationObservation(read.observation);
  const bound = observation !== undefined && observation.network === request.network && observation.owner === request.ownerAccount && observation.delegate === request.delegateAccount;
  const facts = bound ? factsOf(observation) : undefined;
  const evidence = {
    request,
    source,
    ...(facts !== undefined
      ? {
          facts,
          factsDigest: digestOf(TRADE_DELEGATION_FACTS_DIGEST_DOMAIN, facts),
          permissionReading: permissionReadingOf(facts),
          timing: Object.freeze({ observedAt: (observation as TradeDelegationObservation).observedAt, assessedAt: input.assessedAt, maxAgeSeconds: policy.maxAgeSeconds }),
        }
      : {}),
  };

  if (verification.verified) return seal({ schema: TRADE_DELEGATION_ASSESSMENT_SCHEMA, status: 'AUTHORIZED', reason: TRADE_DELEGATION_ASSESSMENT_REASONS.VERIFIED, ...evidence });
  const status: TradeDelegationAssessmentStatus = facts !== undefined && PROVES_NOT_AUTHORIZED.has(verification.code) ? 'NOT_AUTHORIZED' : 'UNAVAILABLE';
  return seal({ schema: TRADE_DELEGATION_ASSESSMENT_SCHEMA, status, reason: verification.code, ...evidence });
}

// ── Consuming an assessment ──────────────────────────────────────────────────

export const TRADE_DELEGATION_RELIANCE_REFUSALS = Object.freeze({
  MALFORMED: 'DELEGATION_RELIANCE_MALFORMED',
  DIGEST_MISMATCH: 'DELEGATION_RELIANCE_DIGEST_MISMATCH',
  NOT_AUTHORIZED: 'DELEGATION_RELIANCE_NOT_AUTHORIZED',
  ORGANIZATION_MISMATCH: 'DELEGATION_RELIANCE_ORGANIZATION_MISMATCH',
  PROPOSAL_MISMATCH: 'DELEGATION_RELIANCE_PROPOSAL_MISMATCH',
  BINDING_MISMATCH: 'DELEGATION_RELIANCE_BINDING_MISMATCH',
  SOURCE_MISMATCH: 'DELEGATION_RELIANCE_SOURCE_MISMATCH',
  FROM_FUTURE: 'DELEGATION_RELIANCE_FROM_FUTURE',
  STALE: 'DELEGATION_RELIANCE_STALE',
} as const);

export type TradeDelegationRelianceRefusal = (typeof TRADE_DELEGATION_RELIANCE_REFUSALS)[keyof typeof TRADE_DELEGATION_RELIANCE_REFUSALS];

export interface TradeDelegationRelianceExpectation {
  /** The accepted proposal the assessment must be for. */
  readonly proposal: TradeProposal;
  readonly proposalDigest: string;
  /** The instant of reliance, from the trusted clock. */
  readonly at: string;
  /** The trusted policy in force now. Its bound applies even if the record states a looser one. */
  readonly policy: TradeDelegationPolicy;
}

export type TradeDelegationReliance = { readonly reliable: true } | { readonly reliable: false; readonly code: TradeDelegationRelianceRefusal };

const MAXIMUM_DATA_DEPTH = 4;
const MAXIMUM_DATA_KEYS = 24;

/** A bounded, getter-free copy of plain JSON data; `undefined` for anything else. */
function plainData(value: unknown, depth: number): unknown {
  if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isSafeInteger(value))) return value;
  if (depth >= MAXIMUM_DATA_DEPTH) return undefined;
  if (Array.isArray(value)) {
    if (value.length > MAXIMUM_DATA_KEYS || Object.getOwnPropertyNames(value).length !== value.length + 1) return undefined;
    const out: unknown[] = [];
    for (let position = 0; position < value.length; position += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, position);
      const item = descriptor !== undefined && 'value' in descriptor ? plainData(descriptor.value, depth + 1) : undefined;
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }
  const snapshot = snapshotTradeRecord(value, MAXIMUM_DATA_KEYS);
  if (!snapshot.ok) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, item] of snapshot.entries) {
    const copied = plainData(item, depth + 1);
    if (copied === undefined) return undefined;
    out[key] = copied;
  }
  return out;
}

/**
 * Whether a previously produced assessment may be relied on **now**, for
 * exactly this proposal: intact (both digests recomputed), `AUTHORIZED`, for
 * the same organization, proposal, network, owner and delegate, from the
 * source the policy names, and still fresh under the policy in force. A
 * reliance is never permanent — every use re-checks the age, and nothing here
 * re-reads the ledger: the execution side must, immediately before signing.
 */
export function checkTradeDelegationReliance(assessment: unknown, expected: TradeDelegationRelianceExpectation): TradeDelegationReliance {
  const R = TRADE_DELEGATION_RELIANCE_REFUSALS;
  const refuse = (code: TradeDelegationRelianceRefusal): TradeDelegationReliance => Object.freeze({ reliable: false as const, code });
  const policy = parseTradeDelegationPolicy(expected.policy);
  if (policy === undefined || !isTradeInstant(expected.at)) return refuse(R.MALFORMED);
  const copy = plainData(assessment, 0) as Record<string, unknown> | undefined;
  if (copy === undefined || copy['schema'] !== TRADE_DELEGATION_ASSESSMENT_SCHEMA || typeof copy['digest'] !== 'string') return refuse(R.MALFORMED);
  const digest = copy['digest'];
  const body: Record<string, unknown> = { ...copy };
  delete body['digest'];
  delete body['diagnostic'];
  let recomputed: string;
  let factsDigest: string | undefined;
  try {
    recomputed = digestOf(TRADE_DELEGATION_ASSESSMENT_DIGEST_DOMAIN, body);
    factsDigest = body['facts'] !== undefined ? digestOf(TRADE_DELEGATION_FACTS_DIGEST_DOMAIN, body['facts']) : undefined;
  } catch {
    return refuse(R.MALFORMED);
  }
  if (recomputed !== digest || factsDigest !== body['factsDigest']) return refuse(R.DIGEST_MISMATCH);
  if (body['status'] !== 'AUTHORIZED' || body['reason'] !== TRADE_DELEGATION_ASSESSMENT_REASONS.VERIFIED) return refuse(R.NOT_AUTHORIZED);

  const request = body['request'] as Record<string, unknown> | undefined;
  const facts = body['facts'] as Record<string, unknown> | undefined;
  const reading = body['permissionReading'] as Record<string, unknown> | undefined;
  const timing = body['timing'] as Record<string, unknown> | undefined;
  const source = body['source'] as Record<string, unknown> | undefined;
  if (request === undefined || facts === undefined || reading === undefined || timing === undefined || source === undefined) return refuse(R.MALFORMED);
  if (facts['state'] !== 'granted' || reading['offerCreateGranted'] !== true || reading['withinTradingScope'] !== true) return refuse(R.NOT_AUTHORIZED);

  const proposal = expected.proposal;
  if (request['organizationId'] !== proposal.organizationId) return refuse(R.ORGANIZATION_MISMATCH);
  if (request['proposalDigest'] !== expected.proposalDigest) return refuse(R.PROPOSAL_MISMATCH);
  if (
    request['network'] !== proposal.network ||
    facts['network'] !== proposal.network ||
    facts['networkId'] !== TRADE_NETWORKS[proposal.network].networkId ||
    request['ownerAccount'] !== proposal.ownerAccount ||
    facts['owner'] !== proposal.ownerAccount ||
    request['delegateAccount'] !== proposal.delegateAccount ||
    facts['delegate'] !== proposal.delegateAccount
  ) {
    return refuse(R.BINDING_MISMATCH);
  }
  if (source['sourceId'] !== policy.sourceId) return refuse(R.SOURCE_MISMATCH);

  const observedAt = timing['observedAt'];
  const recordedBound = timing['maxAgeSeconds'];
  if (!isTradeInstant(observedAt) || typeof recordedBound !== 'number') return refuse(R.MALFORMED);
  const ageMs = Date.parse(expected.at) - Date.parse(observedAt);
  if (ageMs < 0) return refuse(R.FROM_FUTURE);
  if (ageMs > Math.min(policy.maxAgeSeconds, recordedBound) * 1000) return refuse(R.STALE);
  return Object.freeze({ reliable: true as const });
}
