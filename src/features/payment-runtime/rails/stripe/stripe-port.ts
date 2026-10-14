import { centsOfDecimalText } from './stripe-amount.js';
import { isStripeAccountId, isStripeChargeId, isStripeCustomerId, isStripePaymentIntentId, isStripePaymentMethodId } from './stripe-identifiers.js';

/**
 * The Stripe capability boundary (PAY-09) — the domain facts the rail needs
 * from Stripe, and nothing of any Stripe SDK or JSON shape.
 *
 * Split by authority, as PAY-06 splits a Lightning node:
 *
 * - `StripePaymentReader` — reads only: which account the credential belongs
 *   to (and whether it is a test-mode credential), and one PaymentIntent by
 *   its exact id. The P12 resolution authority, the PAY-05 finality authority
 *   and the webhook signal boundary are composed with a reader built by
 *   `readOnlyStripe` — a fresh frozen object with exactly these methods — so
 *   none of them can reach a create or a confirm even by accident. The
 *   reference adapter can also give the reader a Stripe **restricted key**
 *   with read-only PaymentIntents permission (Stripe enforces it).
 * - `StripePaymentPort` — the reader plus `createPaymentIntent` (moves no
 *   money: `confirm=false`) and `confirmPaymentIntent`, **the one
 *   money-moving operation**. Only the rail holds it.
 *
 * ## Answers are facts, not Stripe JSON
 *
 * The adapter copies only the fields below out of Stripe's response — never
 * `client_secret`, `next_action`, `payment_method_details`, a billing address,
 * an email, a card's brand or last four — and the rail reads that copy
 * **closed** (`readStripePaymentIntentView`): an extra key, an accessor, a
 * `Number` amount, an id of the wrong type, an unknown status is not an
 * answer, and an answer that is not an answer is unknown.
 */

/** Stripe's documented PaymentIntent statuses (API reference, `status`). Anything else is unknown. */
export const STRIPE_PAYMENT_INTENT_STATUSES = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'processing', 'requires_capture', 'canceled', 'succeeded'] as const;
export type StripePaymentIntentStatus = (typeof STRIPE_PAYMENT_INTENT_STATUSES)[number];

/** Stripe's documented `capture_method` and `confirmation_method` values — read so a PaymentIntent created any other way is recognized as not ours. */
export const STRIPE_CAPTURE_METHOD_VALUES = ['automatic', 'automatic_async', 'manual'] as const;
export const STRIPE_CONFIRMATION_METHOD_VALUES = ['automatic', 'manual'] as const;

/** Which account a credential acts as. */
export interface StripeAccountView {
  readonly accountId: string;
  /** `true` only for a live-mode credential. The rail refuses it. */
  readonly livemode: boolean;
}

/**
 * One PaymentIntent, as the facts the rail binds. Amounts are integer cents as
 * `BigInt`. `executionId` / `railId` are the bounded correlation the rail wrote
 * into `metadata` at creation — compared, never trusted as authority.
 */
export interface StripePaymentIntentView {
  readonly id: string;
  readonly status: StripePaymentIntentStatus;
  readonly livemode: boolean;
  readonly amountCents: bigint;
  readonly amountReceivedCents: bigint;
  /** Lowercase ISO code, as Stripe writes it. */
  readonly currency: string;
  readonly customerId: string | null;
  readonly paymentMethodId: string | null;
  /** `transfer_data.destination`. */
  readonly destinationAccountId: string | null;
  /** `transfer_data.amount` — the rail never sets it, so it must be absent (`null`). */
  readonly transferAmountCents: bigint | null;
  readonly onBehalfOf: string | null;
  readonly applicationFeeCents: bigint | null;
  readonly captureMethod: string;
  readonly confirmationMethod: string;
  readonly executionId: string | null;
  readonly railId: string | null;
  /** A bounded token for `last_payment_error` (its `code`, or `unspecified`), or `null` when Stripe reports none. Never its message. */
  readonly lastPaymentError: string | null;
  readonly latestChargeId: string | null;
}

/** What the rail asks Stripe to create: a PaymentIntent that **cannot** move money (`confirm=false`). Every value is Frontera's. */
export interface StripeCreateInstruction {
  readonly amountCents: bigint;
  readonly currency: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly destinationAccountId: string;
  /** Bounded correlation written into `metadata`. Never authority. */
  readonly executionId: string;
  readonly railId: string;
  readonly idempotencyKey: string;
  readonly timeoutMs: number;
}

/** The one confirmation: off-session, failing rather than stopping for customer action. */
export interface StripeConfirmInstruction {
  readonly paymentIntentId: string;
  readonly idempotencyKey: string;
  /** How long the adapter waits before it stops listening (the rail then reports `unconfirmed`). */
  readonly timeoutMs: number;
}

/**
 * Thrown by `confirmPaymentIntent` **only** when Stripe provably never received
 * the request — the TCP connection was never established, so not one byte of
 * it left the process. Any other failure means it may have reached Stripe.
 */
export class StripeRequestNotSentError extends Error {
  constructor() {
    super('The Stripe request never left this process.');
    this.name = 'StripeRequestNotSentError';
  }
}

export interface StripePaymentReader {
  retrieveAccount(timeoutMs: number): Promise<unknown>;
  /** One PaymentIntent by its exact id. `{ notFound: true }` when Stripe answers that this account holds no such object. */
  retrievePaymentIntent(paymentIntentId: string, timeoutMs: number): Promise<unknown>;
}

export interface StripePaymentPort extends StripePaymentReader {
  /** Creates the PaymentIntent with `confirm=false`. Moves no money. */
  createPaymentIntent(instruction: StripeCreateInstruction): Promise<unknown>;
  /** The one money-moving operation. At most once per execution, ever. */
  confirmPaymentIntent(instruction: StripeConfirmInstruction): Promise<unknown>;
}

/** The reader capability, alone: a fresh frozen object with no path to create or confirm. */
export function readOnlyStripe(reader: StripePaymentReader): StripePaymentReader {
  const retrieveAccount = reader.retrieveAccount;
  const retrievePaymentIntent = reader.retrievePaymentIntent;
  if (typeof retrieveAccount !== 'function' || typeof retrievePaymentIntent !== 'function') throw new TypeError('A Stripe reader needs retrieveAccount and retrievePaymentIntent.');
  return Object.freeze({
    retrieveAccount: (timeoutMs: number) => retrieveAccount.call(reader, timeoutMs),
    retrievePaymentIntent: (paymentIntentId: string, timeoutMs: number) => retrievePaymentIntent.call(reader, paymentIntentId, timeoutMs),
  });
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Own data properties only — an accessor is refused unread, no Proxy `get` trap consulted. Exactly the allowed keys, all present. */
function closedFields(raw: unknown, keys: readonly string[]): Map<string, unknown> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !keys.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  return values.size === keys.length ? values : undefined;
}

const TOKEN = /^[a-z0-9_]{1,64}$/;
const RAIL_TOKEN = /^[a-z][a-z0-9-]{0,63}$/;
/** An execution id as the rail wrote it into metadata: bounded, printable, no whitespace. Compared exactly, never parsed. */
const CORRELATION = /^[A-Za-z0-9._:@+=-]{1,200}$/;

function nullable<T>(value: unknown, check: (candidate: unknown) => candidate is T): T | null | undefined {
  if (value === null) return null;
  return check(value) ? value : undefined;
}

function nullableCents(value: unknown): bigint | null | undefined {
  if (value === null) return null;
  return centsOfDecimalText(value);
}

const VIEW_KEYS = [
  'id',
  'status',
  'livemode',
  'amountCents',
  'amountReceivedCents',
  'currency',
  'customerId',
  'paymentMethodId',
  'destinationAccountId',
  'transferAmountCents',
  'onBehalfOf',
  'applicationFeeCents',
  'captureMethod',
  'confirmationMethod',
  'executionId',
  'railId',
  'lastPaymentError',
  'latestChargeId',
] as const;

const isToken = (value: unknown): value is string => typeof value === 'string' && TOKEN.test(value);
const isCorrelation = (value: unknown): value is string => typeof value === 'string' && CORRELATION.test(value);
const isRailToken = (value: unknown): value is string => typeof value === 'string' && RAIL_TOKEN.test(value);

/** The adapter's PaymentIntent copy, read closed — or `undefined` (unknown). Cent amounts arrive as decimal text, never a `Number`. */
export function readStripePaymentIntentView(raw: unknown): StripePaymentIntentView | undefined {
  try {
    const values = closedFields(raw, VIEW_KEYS);
    if (values === undefined) return undefined;
    const id = values.get('id');
    const status = values.get('status');
    const livemode = values.get('livemode');
    const amountCents = centsOfDecimalText(values.get('amountCents'));
    const amountReceivedCents = centsOfDecimalText(values.get('amountReceivedCents'));
    const currency = values.get('currency');
    const customerId = nullable(values.get('customerId'), isStripeCustomerId);
    const paymentMethodId = nullable(values.get('paymentMethodId'), isStripePaymentMethodId);
    const destinationAccountId = nullable(values.get('destinationAccountId'), isStripeAccountId);
    const transferAmountCents = nullableCents(values.get('transferAmountCents'));
    const onBehalfOf = nullable(values.get('onBehalfOf'), isStripeAccountId);
    const applicationFeeCents = nullableCents(values.get('applicationFeeCents'));
    const captureMethod = values.get('captureMethod');
    const confirmationMethod = values.get('confirmationMethod');
    const executionId = nullable(values.get('executionId'), isCorrelation);
    const railId = nullable(values.get('railId'), isRailToken);
    const lastPaymentError = nullable(values.get('lastPaymentError'), isToken);
    const latestChargeId = nullable(values.get('latestChargeId'), isStripeChargeId);
    if (!isStripePaymentIntentId(id) || !(STRIPE_PAYMENT_INTENT_STATUSES as readonly unknown[]).includes(status) || typeof livemode !== 'boolean') return undefined;
    if (amountCents === undefined || amountCents <= 0n || amountReceivedCents === undefined || typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return undefined;
    if (customerId === undefined || paymentMethodId === undefined || destinationAccountId === undefined || transferAmountCents === undefined || onBehalfOf === undefined || applicationFeeCents === undefined) return undefined;
    if (!(STRIPE_CAPTURE_METHOD_VALUES as readonly unknown[]).includes(captureMethod) || !(STRIPE_CONFIRMATION_METHOD_VALUES as readonly unknown[]).includes(confirmationMethod)) return undefined;
    if (executionId === undefined || railId === undefined || lastPaymentError === undefined || latestChargeId === undefined) return undefined;
    return Object.freeze({
      id,
      status: status as StripePaymentIntentStatus,
      livemode,
      amountCents,
      amountReceivedCents,
      currency,
      customerId,
      paymentMethodId,
      destinationAccountId,
      transferAmountCents,
      onBehalfOf,
      applicationFeeCents,
      captureMethod: captureMethod as string,
      confirmationMethod: confirmationMethod as string,
      executionId,
      railId,
      lastPaymentError,
      latestChargeId,
    });
  } catch {
    return undefined;
  }
}

/** Whether a retrieval answered "no such PaymentIntent in this account". Never evidence that nothing was charged. */
export function isStripeNotFound(raw: unknown): boolean {
  try {
    const values = closedFields(raw, ['notFound']);
    return values?.get('notFound') === true;
  } catch {
    return false;
  }
}

export function readStripeAccountView(raw: unknown): StripeAccountView | undefined {
  try {
    const values = closedFields(raw, ['accountId', 'livemode']);
    const accountId = values?.get('accountId');
    const livemode = values?.get('livemode');
    return isStripeAccountId(accountId) && typeof livemode === 'boolean' ? Object.freeze({ accountId, livemode }) : undefined;
  } catch {
    return undefined;
  }
}
