import { createHash } from 'node:crypto';

import { canonicalSerialize } from '../governance-store/canonical-json.js';
import { isExecutionCapabilityIdentifier } from '../execution-capability/capability.js';

/**
 * G-02C1C — `frontera.executor-receipt.v1`: an executor's signed statement of
 * what it observed for one durably consumed execution capability.
 *
 * ## What a valid signature proves, and what it does not
 *
 * It proves that the holder of a pinned executor receipt key signed exactly
 * this canonical record: that this executor *says* it consumed this capability
 * for this binding and observed this outcome. It does not prove that the
 * executor told the truth, that a provider completed anything, that a
 * settlement happened, that the capability was issued by a given Host, that no
 * newer receipt exists, or that the effect happened exactly once.
 *
 * ## Closed, canonical, self-consistent
 *
 * The record is `aoc.canonical-json.v1` of a closed set of fields; a presented
 * text must re-serialize to exactly itself. Beyond shape, the parser enforces
 * the record's own consistency, so a well-formed receipt can never state an
 * impossible combination:
 *
 * - `receiptId` is the digest of (executor, capability, sequence): one logical
 *   receipt per position, recomputable by every verifier;
 * - `sequence` 1 has no `supersedes`; every later one supersedes exactly one id;
 * - `completed-observed` ⇔ ledger state `completed`, and only it carries an
 *   `observation` (the synthetic record's name and digest);
 * - `failed-observed` and `consumed-not-attempted` rest on ledger state
 *   `failed` and only on the execution path's own observation (`basis`);
 * - `attempted-outcome-unknown` rests on `claimed`, `outcome-unknown`, or a
 *   `failed` row whose precise cause was not observed;
 * - `observedAt` is never before `claimedAt`.
 *
 * Signing bytes are `frontera:executor-receipt:v1\n` followed by the canonical
 * text — a domain no other artifact uses (pinned by the structure suite).
 */

export const EXECUTOR_RECEIPT_FORMAT = 'frontera.executor-receipt.v1';
export const EXECUTOR_RECEIPT_SIGNING_DOMAIN = 'frontera:executor-receipt:v1\n';
/** The digest domain of a receipt identifier. */
export const EXECUTOR_RECEIPT_ID_DOMAIN = 'frontera.executor-receipt.id.v1';

/** No outcome of an external business transaction or settlement exists here, on purpose. */
export const EXECUTOR_RECEIPT_OUTCOMES = Object.freeze(['consumed-not-attempted', 'attempted-outcome-unknown', 'completed-observed', 'failed-observed'] as const);
export type ExecutorReceiptOutcome = (typeof EXECUTOR_RECEIPT_OUTCOMES)[number];

/** The G-02A consumption state the receipt rests on. */
export const EXECUTOR_RECEIPT_LEDGER_STATES = Object.freeze(['claimed', 'completed', 'failed', 'outcome-unknown'] as const);
export type ExecutorReceiptLedgerState = (typeof EXECUTOR_RECEIPT_LEDGER_STATES)[number];

/** `execution-path`: the executor's own observation at the time of the attempt. `durable-state`: what the durable ledger alone supports. */
export const EXECUTOR_RECEIPT_BASES = Object.freeze(['execution-path', 'durable-state'] as const);
export type ExecutorReceiptBasis = (typeof EXECUTOR_RECEIPT_BASES)[number];

export const EXECUTOR_RECEIPT_OBSERVATION_KIND = 'frontera.synthetic-deployment-record.v1';

export const EXECUTOR_RECEIPT_LIMITS = Object.freeze({ canonicalMaximumLength: 8_192, maximumSequence: 1_000_000 });

export interface ExecutorReceiptObservation {
  readonly kind: typeof EXECUTOR_RECEIPT_OBSERVATION_KIND;
  /** The synthetic record's file name: `<capabilityId>.json`. */
  readonly reference: string;
  /** `sha256:` of the record's exact bytes. */
  readonly digest: string;
}

export interface ExecutorReceipt {
  readonly format: typeof EXECUTOR_RECEIPT_FORMAT;
  readonly receiptId: string;
  readonly executorId: string;
  readonly executorKeyId: string;
  readonly issuer: string;
  readonly capabilityId: string;
  readonly executionId: string;
  readonly audience: string;
  readonly organizationId: string;
  readonly trustDomain: string;
  readonly actionBinding: { readonly format: string; readonly digest: string };
  readonly consumption: { readonly claimedAt: string; readonly ledgerState: ExecutorReceiptLedgerState };
  readonly outcome: ExecutorReceiptOutcome;
  readonly basis: ExecutorReceiptBasis;
  /** The instant of the durable fact the receipt rests on: the outcome's record time, or the claim time while none was recorded. */
  readonly observedAt: string;
  readonly sequence: number;
  readonly supersedes: string | null;
  readonly observation: ExecutorReceiptObservation | null;
}

/** A receipt without its position: what an issuer builds from durable state before the receipt ledger assigns sequence, supersession and id. */
export type ExecutorReceiptDraft = Omit<ExecutorReceipt, 'receiptId' | 'sequence' | 'supersedes'>;

const FIELDS = Object.freeze([
  'actionBinding',
  'audience',
  'basis',
  'capabilityId',
  'consumption',
  'executionId',
  'executorId',
  'executorKeyId',
  'format',
  'issuer',
  'observation',
  'observedAt',
  'organizationId',
  'outcome',
  'receiptId',
  'sequence',
  'supersedes',
  'trustDomain',
] as const satisfies readonly (keyof ExecutorReceipt)[]);

const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !INSTANT.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function identifier(value: unknown): value is string {
  return isExecutionCapabilityIdentifier(value) && !value.includes('*');
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || !keys.every((key) => typeof key === 'string' && fields.includes(key))) return false;
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
  });
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The one identifier of the receipt at `sequence` for this executor and capability. Lowercase hex. */
export function executorReceiptId(position: { readonly executorId: string; readonly capabilityId: string; readonly sequence: number }): string {
  return sha256(canonicalSerialize({ domain: EXECUTOR_RECEIPT_ID_DOMAIN, executorId: position.executorId, capabilityId: position.capabilityId, sequence: position.sequence }));
}

/** Which outcomes a ledger state, and a basis, can support. */
function outcomeConsistent(outcome: unknown, ledgerState: unknown, basis: unknown): boolean {
  switch (outcome) {
    case 'completed-observed':
      return ledgerState === 'completed';
    case 'failed-observed':
    case 'consumed-not-attempted':
      return ledgerState === 'failed' && basis === 'execution-path';
    case 'attempted-outcome-unknown':
      return ledgerState === 'claimed' || ledgerState === 'outcome-unknown' || (ledgerState === 'failed' && basis === 'durable-state');
    default:
      return false;
  }
}

/** Shape and self-consistency. Says nothing about who signed it. */
export function isWellFormedExecutorReceipt(value: unknown): value is ExecutorReceipt {
  if (!exactFields(value, FIELDS)) return false;
  const r = value;
  const binding = r['actionBinding'];
  const consumption = r['consumption'];
  const observation = r['observation'];
  const sequence = r['sequence'];
  const supersedes = r['supersedes'];
  if (!exactFields(binding, ['digest', 'format']) || !identifier(binding['format']) || typeof binding['digest'] !== 'string' || !DIGEST.test(binding['digest'])) return false;
  if (!exactFields(consumption, ['claimedAt', 'ledgerState']) || !isInstant(consumption['claimedAt']) || !(EXECUTOR_RECEIPT_LEDGER_STATES as readonly unknown[]).includes(consumption['ledgerState'])) return false;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > EXECUTOR_RECEIPT_LIMITS.maximumSequence) return false;
  const chained = sequence === 1 ? supersedes === null : typeof supersedes === 'string' && HEX64.test(supersedes);
  if (!chained) return false;
  const capabilityId = r['capabilityId'];
  if (typeof capabilityId !== 'string' || !HEX64.test(capabilityId)) return false;
  if (observation !== null) {
    if (!exactFields(observation, ['digest', 'kind', 'reference'])) return false;
    if (observation['kind'] !== EXECUTOR_RECEIPT_OBSERVATION_KIND || observation['reference'] !== `${capabilityId}.json` || typeof observation['digest'] !== 'string' || !DIGEST.test(observation['digest'])) return false;
  }
  const completed = r['outcome'] === 'completed-observed';
  if (completed !== (observation !== null)) return false;
  if (!outcomeConsistent(r['outcome'], consumption['ledgerState'], r['basis']) || !(EXECUTOR_RECEIPT_BASES as readonly unknown[]).includes(r['basis'])) return false;
  const observedAt = r['observedAt'];
  if (!isInstant(observedAt) || observedAt < (consumption['claimedAt'] as string)) return false;
  const executorId = r['executorId'];
  return (
    r['format'] === EXECUTOR_RECEIPT_FORMAT &&
    identifier(executorId) &&
    identifier(r['executorKeyId']) &&
    identifier(r['issuer']) &&
    identifier(r['executionId']) &&
    identifier(r['audience']) &&
    identifier(r['organizationId']) &&
    identifier(r['trustDomain']) &&
    typeof r['receiptId'] === 'string' &&
    r['receiptId'] === executorReceiptId({ executorId, capabilityId, sequence })
  );
}

/** The canonical text a receipt is signed over (after the domain). Refuses a receipt that is not well formed. */
export function serializeExecutorReceipt(receipt: ExecutorReceipt): string {
  if (!isWellFormedExecutorReceipt(receipt)) throw new TypeError('A receipt that is not well formed has no canonical form.');
  return canonicalSerialize(receipt);
}

/** The exact signing bytes: the receipt domain, then the canonical text. One function for the signer and every verifier. */
export function executorReceiptSigningBytes(receipt: ExecutorReceipt): Buffer {
  return Buffer.from(`${EXECUTOR_RECEIPT_SIGNING_DOMAIN}${serializeExecutorReceipt(receipt)}`, 'utf8');
}

/** `sha256:` of the canonical text — how a receipt ledger detects a changed record. */
export function executorReceiptDigest(canonical: string): string {
  return `sha256:${sha256(canonical)}`;
}

/** The receipt at a position: the draft plus its sequence, supersession and the identifier they determine. */
export function positionExecutorReceipt(draft: ExecutorReceiptDraft, sequence: number, supersedes: string | null): ExecutorReceipt {
  const receipt = { ...draft, receiptId: executorReceiptId({ executorId: draft.executorId, capabilityId: draft.capabilityId, sequence }), sequence, supersedes };
  if (!isWellFormedExecutorReceipt(receipt)) throw new TypeError('The receipt at this position is not well formed.');
  return Object.freeze(receipt);
}

export type ExecutorReceiptParseFailure = 'RECEIPT_MALFORMED' | 'RECEIPT_FORMAT_UNSUPPORTED' | 'RECEIPT_NONCANONICAL';

/** Parses a receipt from its canonical text; every other spelling is refused, never normalized. */
export function parseExecutorReceipt(canonical: unknown): { readonly ok: true; readonly receipt: ExecutorReceipt } | { readonly ok: false; readonly failure: ExecutorReceiptParseFailure } {
  const refuse = (failure: ExecutorReceiptParseFailure) => ({ ok: false as const, failure });
  if (typeof canonical !== 'string' || canonical.length === 0 || canonical.length > EXECUTOR_RECEIPT_LIMITS.canonicalMaximumLength || UNPAIRED_SURROGATE.test(canonical)) return refuse('RECEIPT_MALFORMED');
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    return refuse('RECEIPT_MALFORMED');
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const format = (parsed as Record<string, unknown>)['format'];
    if (typeof format === 'string' && format !== EXECUTOR_RECEIPT_FORMAT) return refuse('RECEIPT_FORMAT_UNSUPPORTED');
  }
  if (!isWellFormedExecutorReceipt(parsed)) return refuse('RECEIPT_MALFORMED');
  return canonicalSerialize(parsed) === canonical ? { ok: true, receipt: Object.freeze(parsed) } : refuse('RECEIPT_NONCANONICAL');
}
