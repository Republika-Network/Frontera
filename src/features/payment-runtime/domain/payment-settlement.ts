import { isRecordableProviderRef } from '../../execution-runtime/index.js';
import { isWellFormedMonetaryAmount, type MonetaryAmount } from '../../monetary-runtime/index.js';
import { isPaymentBusinessReference, isPaymentDestinationKind, isPaymentRailId, isPaymentReference, isPlainRecord, isSecretShapedPropertyName } from './payment-grammar.js';
import { isPaymentPurpose, type PaymentDestination, type PaymentPurpose, type PaymentSourceRef } from './payment-intent.js';

/**
 * Settlement — what "settled" means for a governed payment (PAY-05).
 *
 * > **A payment is `settled` only when a trusted finality authority has
 * > established funds finality for exactly that payment, and evidence
 * > sufficient to say why is recorded.**
 *
 * ## Four facts that are not one another
 *
 * ```
 * P11 confirmed-completed      the provider confirmed the instruction completed
 * P12 resolved / completed     a trusted authority later established the effect completed
 * P7  reservation "settled"    CAPACITY settlement: budget stays consumed — never funds
 * PAY-05 settled               FUNDS settlement: final, with evidence
 * ```
 *
 * P11 and P12 answer *did the execution complete?* and are the only basis a
 * settlement may be attempted from; neither is ever called "settled" here, and
 * neither is ever changed by a settlement. P7's word "settled" means the
 * capacity a reservation consumed stays consumed; nothing in PAY-05 reads or
 * writes P7. A receipt describes a settlement; an obligation discharge may
 * consume one. None of them creates one.
 *
 * ## The state machine (closed)
 *
 * ```
 *                       P12 resolves completed                     PAY-05 verifies finality
 * execution-uncertain ─────────────────────────▶ awaiting-finality ─────────────────────────▶ settled  (terminal)
 *        │                                              ▲
 *        │ P12 resolves not completed                   │ P11 confirmed-completed
 *        ▼                                              │
 * not-settleable (terminal)  ◀── P11 confirmed-not-completed / withheld
 * ```
 *
 * Only one transition is PAY-05's own and only one is ever stored:
 * `awaiting-finality → settled`. Every other state is **derived**, on read,
 * from P11 and P12 — never copied, so there is no second truth to diverge. A
 * finality authority that is unavailable, says "not yet", or times out leaves
 * the state where it was: unknown is not failed, timeout is not evidence, time
 * passing is never finality, and a network error is never "not settled".
 * `settled` is terminal for the original payment: a refund is a new governed
 * payment with its own settlement, and never un-settles this one.
 */

/** The derived read vocabulary. Closed. */
export const PAYMENT_SETTLEMENT_STATES = ['execution-uncertain', 'awaiting-finality', 'settled', 'not-settleable'] as const;

export type PaymentSettlementState = (typeof PAYMENT_SETTLEMENT_STATES)[number];

/** Every legal transition of the graph above. Anything else — `settled` to anything in particular — is illegal and fails closed. */
const LEGAL_TRANSITIONS: ReadonlySet<string> = new Set(['execution-uncertain>awaiting-finality', 'execution-uncertain>not-settleable', 'awaiting-finality>settled']);

export function isLegalPaymentSettlementTransition(from: PaymentSettlementState, to: PaymentSettlementState): boolean {
  return LEGAL_TRANSITIONS.has(`${from}>${to}`);
}

/** The terminal states. Nothing leaves them. */
export function isTerminalPaymentSettlementState(state: PaymentSettlementState): boolean {
  return state === 'settled' || state === 'not-settleable';
}

/**
 * The only two bases a settlement may be attempted from — both derived from
 * verified durable state, neither from a caller, a provider handle, a
 * challenge, a business operation or a P7 reservation.
 *
 * - `provider-confirmed-completed` — P11's initial observation is
 *   `confirmed-completed`.
 * - `resolution-confirmed-completed` — P11 is `unconfirmed` (or holds no
 *   observation) and P12 recorded a definitive `confirmed-completed`.
 */
export const PAYMENT_SETTLEMENT_BASES = ['provider-confirmed-completed', 'resolution-confirmed-completed'] as const;

export type PaymentSettlementBasisKind = (typeof PAYMENT_SETTLEMENT_BASES)[number];

/**
 * The canonical payment a settlement is about: the committed decision's own
 * axes (source = the governed resource, destination = the counterparty) and
 * P11's amount and exact-bound parameters. Rail-neutral.
 */
export interface PaymentSettlementTerms {
  readonly source: PaymentSourceRef;
  readonly destination: PaymentDestination;
  readonly amount: MonetaryAmount;
  readonly purpose: PaymentPurpose;
  readonly reference?: string;
  readonly rail?: string;
}

/**
 * What a finality authority is asked. Every field comes from verified durable
 * state (P11, P12 and the committed decision) — the caller who started the
 * payment contributed none of it. Frozen.
 */
export interface PaymentFinalityQuery {
  readonly organizationId: string;
  readonly executionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly basis: PaymentSettlementBasisKind;
  /** The rail P11 recorded as having performed the effect, when one did. */
  readonly railId?: string;
  /** The opaque handle P11 or P12 recorded. A locator, never proof. */
  readonly providerRef?: string;
  readonly payment: PaymentSettlementTerms;
}

/**
 * One normalized fact a finality authority verified, as a short name and a
 * short value — `{ name: '<rail>.<fact>', value }`. The generic contract never
 * names a rail's facts; a rail's authority chooses its own names below its own
 * prefix. Never a provider body, never a secret.
 */
export interface PaymentFinalityFact {
  readonly name: string;
  readonly value: string;
}

/**
 * The bounded, canonical evidence a finality authority returns with a `final`
 * answer. It restates the payment it verified, so Frontera compares it —
 * exactly, field by field — with the canonical basis before believing it.
 */
export interface PaymentFinalityEvidence {
  readonly executionId: string;
  /** How finality was established, versioned — `<rail>.<method>.v<n>`. */
  readonly method: string;
  /** The rail's handle on the final transfer. Must equal the handle P11 / P12 recorded, when one was. */
  readonly providerRef: string;
  readonly amount: MonetaryAmount;
  readonly source: PaymentSourceRef;
  readonly destination: PaymentDestination;
  /** When the rail made the transfer final — an instant the rail itself established, never a local clock. Optional. */
  readonly finalizedAt?: string;
  /** Normalized rail facts the authority verified, sorted by name, unique. */
  readonly facts: readonly PaymentFinalityFact[];
}

/** The closed answer. Anything else an authority returns is not an answer. */
export type PaymentFinalityAnswer =
  | { readonly outcome: 'final'; readonly evidence: PaymentFinalityEvidence }
  /** Not established — pending, unknown, unavailable, unreadable. Never a negative. */
  | { readonly outcome: 'not-final' }
  /**
   * The rail proves the governed transfer did **not** reach finality as
   * governed although P11 / P12 say the execution completed (for example a
   * validated failure, or a different amount delivered). Nothing is recorded:
   * P11 and P12 are never rewritten, and contradicting trusted facts are an
   * operator's question.
   */
  | { readonly outcome: 'contradicted'; readonly reason: string };

/**
 * The trusted, rail-specific finality authority — the one port through which
 * Frontera learns that a completed payment's funds are final.
 *
 * ## Trusted to interpret one rail's finality — nothing else
 *
 * It is host composition, never reachable from a customer. Its compromise can
 * falsely declare a payment settled (and so let a payment obligation verify,
 * or let a refund be requested against it); that trust boundary is stated
 * here, not hidden. It is narrowed four ways: the query is canonical context
 * it cannot change; the answer is closed and bounded; its evidence is compared
 * exactly with the canonical payment; and it holds no capability to submit,
 * sign, spend, issue authority, create a grant, alter P11 / P12 or touch P7.
 *
 * ## Read-only
 *
 * `verifyFinality` may read the rail's state. It must **not** submit, sign,
 * resubmit, build a payment or otherwise act on the rail to learn anything.
 * Frontera asks it only from an explicit verification, at most once per call;
 * there is no timer and no background polling.
 */
export interface PaymentFinalityAuthority {
  /** Recordable identity, unique among the composed authorities. Snapshotted at composition. */
  readonly authorityId: string;
  verifyFinality(query: PaymentFinalityQuery): Promise<PaymentFinalityAnswer>;
}

/** Bounds on everything a finality answer may carry. */
export const PAYMENT_FINALITY_EVIDENCE_LIMITS = Object.freeze({
  methodLength: 64,
  reasonLength: 64,
  factCount: 16,
  factNameLength: 64,
  factValueLength: 256,
  instantLength: 40,
});

/** A dotted, hyphenated lowercase name — `acme.final-proof.v1`. The grammar of a method, a reason and a fact name. */
const DOTTED_NAME = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** The lexical shape of an instant in UTC, millisecond or second precision: `2026-10-12T09:30:00Z` / `…:00.000Z`. Shape only — see `isPaymentFinalityInstant`. */
const UTC_INSTANT = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{3})?Z$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** The value of a run of ASCII digits the shape already matched — a calendar field, never money. */
function digitsOf(text: string | undefined): number {
  let value = 0;
  for (let index = 0; index < (text ?? '').length; index += 1) value = value * 10 + ((text ?? '').charCodeAt(index) - 48);
  return value;
}

function isDottedName(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && DOTTED_NAME.test(value);
}

export function isPaymentFinalityMethod(value: unknown): value is string {
  return isDottedName(value, PAYMENT_FINALITY_EVIDENCE_LIMITS.methodLength);
}

/**
 * A real UTC instant, never read as a clock: the canonical shape **and** a date
 * that exists in the proleptic Gregorian calendar — the day within its month's
 * length, February 29 only in a leap year (every fourth year, except centuries
 * not divisible by 400). `2026-02-29`, `2026-02-31` or `2026-04-31`, which a
 * lenient date parser would roll over into the next month, are refused, never
 * repaired. Pure arithmetic over the text — no `Date`. The same semantics as
 * P11's `isCanonicalOutcomeInstant`, which also admits the second-precision form.
 */
export function isPaymentFinalityInstant(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > PAYMENT_FINALITY_EVIDENCE_LIMITS.instantLength) return false;
  const shape = UTC_INSTANT.exec(value);
  if (shape === null) return false;
  const year = digitsOf(shape[1]);
  const month = digitsOf(shape[2]);
  const day = digitsOf(shape[3]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const length = month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day <= length;
}

/**
 * A fact name may not announce secret material: such a fact is refused, its
 * value never read. The name is checked with its separators folded (`private-key`,
 * `private.key` and `private_key` are one name), so a separator cannot hide one.
 */
export function isPaymentFinalityFactName(value: unknown): value is string {
  return isDottedName(value, PAYMENT_FINALITY_EVIDENCE_LIMITS.factNameLength) && !isSecretShapedPropertyName(value) && !isSecretShapedPropertyName(value.replace(/[.-]/g, '_')) && !isSecretShapedPropertyName(value.replace(/[.-]/g, ''));
}

/** A fact value: a recordable reference (no credential, JWT, PEM, URL, cookie or header shape), bounded, no whitespace. */
export function isPaymentFinalityFactValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= PAYMENT_FINALITY_EVIDENCE_LIMITS.factValueLength && !/\s/.test(value) && isRecordableProviderRef(value);
}

function ownValues(raw: unknown, keys: readonly string[], required: readonly string[]): Map<string, unknown> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !keys.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    // A plain data property only: an accessor is refused unread, and no Proxy trap is consulted.
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  return required.every((key) => values.has(key)) ? values : undefined;
}

function readAmount(raw: unknown): MonetaryAmount | undefined {
  const values = ownValues(raw, ['value', 'unit'], ['value', 'unit']);
  if (values === undefined) return undefined;
  const amount = { value: values.get('value'), unit: values.get('unit') };
  return isWellFormedMonetaryAmount(amount) ? Object.freeze({ value: amount.value, unit: amount.unit }) : undefined;
}

function readSource(raw: unknown): PaymentSourceRef | undefined {
  const values = ownValues(raw, ['accountId'], ['accountId']);
  const accountId = values?.get('accountId');
  return isPaymentReference(accountId) ? Object.freeze({ accountId }) : undefined;
}

function readDestination(raw: unknown): PaymentDestination | undefined {
  const values = ownValues(raw, ['kind', 'reference'], ['kind', 'reference']);
  const kind = values?.get('kind');
  const reference = values?.get('reference');
  return isPaymentDestinationKind(kind) && isPaymentReference(reference) ? Object.freeze({ kind, reference }) : undefined;
}

function readFacts(raw: unknown): readonly PaymentFinalityFact[] | undefined {
  if (!Array.isArray(raw) || raw.length > PAYMENT_FINALITY_EVIDENCE_LIMITS.factCount) return undefined;
  // A dense list with no property but its indices and length.
  if (Reflect.ownKeys(raw).length !== raw.length + 1) return undefined;
  const facts: PaymentFinalityFact[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    // The name is checked before the value is read: a secret-named fact's value is never looked at.
    const entry = ownValues(descriptor.value, ['name', 'value'], ['name', 'value']);
    const name = entry?.get('name');
    if (!isPaymentFinalityFactName(name)) return undefined;
    const value = entry?.get('value');
    if (!isPaymentFinalityFactValue(value)) return undefined;
    facts.push(Object.freeze({ name, value }));
  }
  const sorted = [...facts].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) if (sorted[index - 1]?.name === sorted[index]?.name) return undefined;
  return Object.freeze(sorted);
}

const EVIDENCE_KEYS = ['executionId', 'method', 'providerRef', 'amount', 'source', 'destination', 'finalizedAt', 'facts'];
const EVIDENCE_REQUIRED = ['executionId', 'method', 'providerRef', 'amount', 'source', 'destination', 'facts'];

/** Reads one evidence object closed, or `undefined` when anything about it is outside the contract. Never repaired. */
export function readPaymentFinalityEvidence(raw: unknown): PaymentFinalityEvidence | undefined {
  try {
    const values = ownValues(raw, EVIDENCE_KEYS, EVIDENCE_REQUIRED);
    if (values === undefined) return undefined;
    const executionId = values.get('executionId');
    const method = values.get('method');
    const providerRef = values.get('providerRef');
    const finalizedAt = values.get('finalizedAt');
    if (!isPaymentReference(executionId) || !isPaymentFinalityMethod(method) || !isRecordableProviderRef(providerRef)) return undefined;
    if (finalizedAt !== undefined && !isPaymentFinalityInstant(finalizedAt)) return undefined;
    const amount = readAmount(values.get('amount'));
    const source = readSource(values.get('source'));
    const destination = readDestination(values.get('destination'));
    const facts = readFacts(values.get('facts'));
    if (amount === undefined || source === undefined || destination === undefined || facts === undefined) return undefined;
    return Object.freeze({ executionId, method, providerRef, amount, source, destination, ...(finalizedAt !== undefined ? { finalizedAt } : {}), facts });
  } catch {
    return undefined;
  }
}

/**
 * Treats a finality authority's answer as external integration output: read
 * once, closed, into a fresh frozen value — or `undefined` when it is not
 * exactly one closed answer. A Proxy, an accessor, an extra key, an oversized
 * or secret-named fact, a non-canonical amount: not an answer. An answer that
 * is not an answer is never "final".
 */
export function normalizePaymentFinalityAnswer(raw: unknown): PaymentFinalityAnswer | undefined {
  try {
    const values = ownValues(raw, ['outcome', 'evidence', 'reason'], ['outcome']);
    if (values === undefined) return undefined;
    const outcome = values.get('outcome');
    if (outcome === 'not-final') return values.size === 1 ? Object.freeze({ outcome: 'not-final' }) : undefined;
    if (outcome === 'contradicted') {
      const reason = values.get('reason');
      return values.size === 2 && isDottedName(reason, PAYMENT_FINALITY_EVIDENCE_LIMITS.reasonLength) ? Object.freeze({ outcome: 'contradicted', reason }) : undefined;
    }
    if (outcome !== 'final' || values.size !== 2) return undefined;
    const evidence = readPaymentFinalityEvidence(values.get('evidence'));
    return evidence === undefined ? undefined : Object.freeze({ outcome: 'final', evidence });
  } catch {
    return undefined;
  }
}

/** The fields an exact match is decided on. */
export type PaymentSettlementMismatch = 'execution' | 'provider-reference' | 'amount' | 'asset' | 'source' | 'destination';

/**
 * Exact comparison of a final answer's evidence with the canonical basis. No
 * fuzzy matching: no "same amount, so the same payment", no normalization, no
 * tolerance. The first mismatch is returned; `undefined` means every field is
 * identical. A provider handle on record must be the evidence's handle.
 */
export function paymentFinalityMismatch(evidence: PaymentFinalityEvidence, query: PaymentFinalityQuery): PaymentSettlementMismatch | undefined {
  if (evidence.executionId !== query.executionId) return 'execution';
  if (query.providerRef !== undefined && evidence.providerRef !== query.providerRef) return 'provider-reference';
  if (evidence.amount.unit !== query.payment.amount.unit) return 'asset';
  if (evidence.amount.value !== query.payment.amount.value) return 'amount';
  if (evidence.source.accountId !== query.payment.source.accountId) return 'source';
  if (evidence.destination.kind !== query.payment.destination.kind || evidence.destination.reference !== query.payment.destination.reference) return 'destination';
  return undefined;
}

/** Whether a value is a well-formed set of settlement terms. Shape only. */
export function isPaymentSettlementTerms(value: unknown): value is PaymentSettlementTerms {
  if (!isPlainRecord(value)) return false;
  const terms = value as Partial<PaymentSettlementTerms>;
  return (
    readSource(terms.source) !== undefined &&
    readDestination(terms.destination) !== undefined &&
    readAmount(terms.amount) !== undefined &&
    isPaymentPurpose(terms.purpose) &&
    (terms.reference === undefined || isPaymentBusinessReference(terms.reference)) &&
    (terms.rail === undefined || isPaymentRailId(terms.rail))
  );
}
