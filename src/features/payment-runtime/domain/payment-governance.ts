import type { ParameterDimensionDeclaration } from '../../governed-parameter-runtime/index.js';
import { isPaymentDestinationKind, isPaymentEnvelopeIdentifier, isPaymentReference, isPlainRecord } from './payment-grammar.js';
import { snapshotPaymentIntent, type PaymentDestination, type PaymentIntent } from './payment-intent.js';

/**
 * How a payment becomes a governed action (PAY-01).
 *
 * > A payment intent **compiles down** to the generic governed-action
 * > envelope. It is never a second way in.
 *
 * ```
 * PaymentIntent              GovernedActionIntent           governed axis
 * ─────────────────────────  ─────────────────────────────  ─────────────────────────────────────────
 * (binding.action)        →  action                         Kernel action.type · grant action bound
 * source.accountId        →  resource                       resourceScope · grant resource set
 * destination             →  counterparty "<kind>:<ref>"    counterpartyId · grant counterparty bound
 * amount {value, unit}    →  amount {value, currency}       P9 amount · P10 ceiling · P7 exposure
 * purpose                 →  parameters.paymentPurpose      CORE-03 token, bound exactly
 * reference               →  parameters.paymentReference    CORE-03 token, bound exactly
 * rail                    →  parameters.paymentRail         CORE-03 token, bound exactly
 * idempotencyKey          →  idempotencyKey                 request identity, replay / conflict
 * correlationId           →  correlationId
 * ```
 *
 * Every payment field lands on an axis the governed path **already** decides,
 * bounds, records and discloses. Nothing here evaluates policy, consults
 * authority, issues anything or reaches a rail: the output is plain intent
 * data, and the one thing a caller can do with it is hand it to the Governed
 * Action Orchestrator — which validates it again, in full, against the same
 * trusted configuration it validates every governed action against.
 *
 * ## What the host must compose (and what happens if it does not)
 *
 * - the bound action listed in `monetary.financialActions` — otherwise the
 *   envelope refuses the amount;
 * - `PAYMENT_PARAMETER_DIMENSIONS` declared, and a Governance Profile over the
 *   payment action class × the governed source accounts' resource class whose
 *   parameters are `PAYMENT_PROFILE_PARAMETERS` — otherwise the envelope
 *   refuses the parameters.
 *
 * Both failures are refusals before evaluation. There is no fallback in which
 * a payment is governed as something less.
 */

/** The CORE-03 dimension ids a payment states. Lower-camel semantic identifiers; reserved in asserted context by the registry as every declared dimension is. */
export const PAYMENT_PARAMETER_DIMENSION_IDS = {
  purpose: 'paymentPurpose',
  reference: 'paymentReference',
  rail: 'paymentRail',
} as const;

/** Declarations for a host's `governance.parameterDimensions`. Tokens, bound `exact`: a grant for one purpose, reference or rail is never a grant for another. */
export const PAYMENT_PARAMETER_DIMENSIONS: readonly ParameterDimensionDeclaration[] = Object.freeze([
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.purpose, type: 'token', bound: 'exact' } as const),
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.reference, type: 'token', bound: 'exact' } as const),
  Object.freeze({ id: PAYMENT_PARAMETER_DIMENSION_IDS.rail, type: 'token', bound: 'exact' } as const),
]);

/** The parameter list for a payment Governance Profile: purpose required, reference and rail optional. */
export const PAYMENT_PROFILE_PARAMETERS: readonly { readonly dimension: string; readonly required: boolean }[] = Object.freeze([
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.purpose, required: true }),
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.reference, required: false }),
  Object.freeze({ dimension: PAYMENT_PARAMETER_DIMENSION_IDS.rail, required: false }),
]);

/**
 * Trusted host configuration: which governed action identifier *is* a payment
 * in this deployment. Not a constant, because what an action is called is the
 * deployment's vocabulary; not caller input, because a caller who could name
 * the action could name a different one.
 */
export interface PaymentGovernanceBinding {
  readonly action: string;
}

export class PaymentConfigurationError extends Error {
  readonly code: 'PAYMENT_CONFIGURATION_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'PaymentConfigurationError';
    this.code = 'PAYMENT_CONFIGURATION_INVALID';
  }
}

/** Builds the frozen binding, or throws `PaymentConfigurationError`. Wiring-time. */
export function createPaymentGovernanceBinding(configuration: { readonly action: string }): PaymentGovernanceBinding {
  const action: unknown = configuration?.action;
  if (!isPaymentEnvelopeIdentifier(action)) throw new PaymentConfigurationError('The payment action must be a canonical governed action identifier.');
  return Object.freeze({ action });
}

/** The separator between a destination's kind and its reference. A kind never contains it, so the first one splits exactly. */
const DESTINATION_SEPARATOR = ':';

/** The one encoding of a destination as the governed counterparty: `<kind>:<reference>`. Injective: two destinations never share a counterparty. */
export function paymentCounterpartyOf(destination: PaymentDestination): string {
  // Each field read once; the encoded value is exactly the one checked.
  const kind: unknown = destination?.kind;
  const reference: unknown = destination?.reference;
  if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) throw new RangeError('The destination is not canonical.');
  return `${kind}${DESTINATION_SEPARATOR}${reference}`;
}

/** The inverse of `paymentCounterpartyOf`, or `undefined` for a counterparty no canonical destination encodes to. */
export function paymentDestinationOf(counterparty: unknown): PaymentDestination | undefined {
  if (typeof counterparty !== 'string') return undefined;
  const separator = counterparty.indexOf(DESTINATION_SEPARATOR);
  if (separator === -1) return undefined;
  const kind = counterparty.slice(0, separator);
  const reference = counterparty.slice(separator + 1);
  if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) return undefined;
  return Object.freeze({ kind, reference });
}

/**
 * The governed-action intent a payment compiles to — structurally the
 * envelope's own `GovernedActionIntent`, stated here rather than imported
 * because a feature module never depends on the enterprise layer. An
 * enterprise test proves the two stay assignable.
 */
export interface PaymentGovernedActionIntent {
  readonly action: string;
  readonly resource: string;
  readonly counterparty: string;
  readonly amount: { readonly value: string; readonly currency: string };
  readonly parameters: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
  readonly correlationId?: string;
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

/**
 * Envelope-owned fields a caller may pass through unchanged: the evidence it
 * asserts (a passport, a capability token) and a profile pin. They are not
 * payment semantics, so they are not on `PaymentIntent`; the orchestrator
 * validates both exactly as it validates them for any governed action.
 */
export interface PaymentEnvelopeOptions {
  readonly assertedContext?: Readonly<Record<string, unknown>>;
  readonly expectedGovernanceProfile?: { readonly id: string; readonly version: number };
}

/** Deepest asserted-context nesting a compiled payment will copy — the envelope's own bound. */
const ENVELOPE_COPY_MAXIMUM_DEPTH = 8;

/** Widest array or object a compiled payment will copy per level — the envelope's own `MAX_CONTEXT_KEYS`, checked **before** anything is traversed. */
const ENVELOPE_COPY_MAXIMUM_WIDTH = 64;

const refuseEnvelope = (reason: string): never => {
  throw new RangeError(`Envelope data must be plain JSON data: ${reason}.`);
};

/** One own property's value, if it is an enumerable data property; otherwise refused — never run, never skipped. */
function envelopeDataValue(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) return refuseEnvelope('every property must be an enumerable data property');
  return descriptor.value as unknown;
}

/**
 * A fresh, frozen copy of envelope-owned JSON data, so nothing the caller
 * still holds can change a compiled payment — and therefore its digest and
 * decision — after compilation.
 *
 * Exactly JSON, so that the copy and its canonical serialization describe the
 * same value: finite numbers only (`NaN` and `Infinity` have no JSON form)
 * and never `-0` (it serializes as `0`);
 * dense arrays only (a hole would serialize like a shorter array and let two
 * different contexts share one digest); every own property an enumerable
 * string-keyed data property (a non-enumerable or symbol property would be
 * dropped silently rather than refused); at most 64 entries per level,
 * checked before anything is traversed; bounded depth, which also refuses a
 * cycle. Keys are *defined*, never assigned, so an own `__proto__` key stays
 * data. Anything else is refused, never coerced; the orchestrator's own
 * validation still runs on the result.
 */
function snapshotEnvelopeValue(value: unknown, depth: number): unknown {
  if (depth > ENVELOPE_COPY_MAXIMUM_DEPTH) return refuseEnvelope('nested too deeply');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  // Finite, and never -0: canonical serialization writes -0 as 0, so a kept -0 would let two contexts policy can tell apart share one digest.
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : refuseEnvelope('numbers must be finite and not -0');
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    const length = value.length;
    if (length > ENVELOPE_COPY_MAXIMUM_WIDTH) return refuseEnvelope(`at most ${ENVELOPE_COPY_MAXIMUM_WIDTH} entries per level`);
    // Exactly the indices 0…length-1, plus `length` itself: no hole, no extra or symbol property.
    if (keys.length !== length + 1) return refuseEnvelope('arrays must be dense and carry no other properties');
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) return refuseEnvelope('arrays must be dense');
      out.push(snapshotEnvelopeValue(envelopeDataValue(value, String(index)), depth + 1));
    }
    return Object.freeze(out);
  }
  if (isPlainRecord(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.length > ENVELOPE_COPY_MAXIMUM_WIDTH) return refuseEnvelope(`at most ${ENVELOPE_COPY_MAXIMUM_WIDTH} entries per level`);
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== 'string') return refuseEnvelope('symbol properties are not data');
      Object.defineProperty(out, key, { value: snapshotEnvelopeValue(envelopeDataValue(value, key), depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  }
  return refuseEnvelope('not a JSON value');
}

/**
 * The envelope options themselves, read **once**: a plain record whose only
 * own properties are `assertedContext` and `expectedGovernanceProfile`, each
 * an enumerable data property. An accessor is refused without being run — a
 * getter could answer `undefined` to an omission test and data to the
 * snapshot, or different data each time.
 */
function readEnvelopeOptions(envelope: unknown): { readonly assertedContext?: unknown; readonly expectedGovernanceProfile?: unknown } {
  if (envelope === undefined) return {};
  if (!isPlainRecord(envelope)) return refuseEnvelope('the envelope options must be a plain object');
  const out: { assertedContext?: unknown; expectedGovernanceProfile?: unknown } = {};
  for (const key of Reflect.ownKeys(envelope)) {
    if (key !== 'assertedContext' && key !== 'expectedGovernanceProfile') return refuseEnvelope('the envelope options carry an undeclared property');
    out[key] = envelopeDataValue(envelope, key);
  }
  return out;
}

/** Exactly `{ id, version }` as two data properties, read once — anything more or other is refused, never repaired into a clean pin. */
function snapshotProfileExpectation(value: unknown): { readonly id: string; readonly version: number } {
  const refuse = (): never => {
    throw new RangeError('expectedGovernanceProfile must be exactly { id, version }.');
  };
  if (!isPlainRecord(value)) return refuse();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('version')) return refuse();
  const id = Object.getOwnPropertyDescriptor(value, 'id');
  const version = Object.getOwnPropertyDescriptor(value, 'version');
  if (id === undefined || version === undefined || !('value' in id) || !('value' in version)) return refuse();
  if (typeof id.value !== 'string' || typeof version.value !== 'number' || !Number.isFinite(version.value) || Object.is(version.value, -0)) return refuse();
  return Object.freeze({ id: id.value, version: version.value });
}

/**
 * Compiles a validated payment intent to its governed-action intent.
 *
 * Pure and deterministic: the same intent and binding always produce an
 * equal, frozen object with the same key order, so its digest — and therefore
 * idempotency replay and conflict on the governed path — is a function of the
 * payment alone. Envelope-owned values are copied and frozen too. Throws
 * `RangeError` for a value that is not a canonical payment intent, or for
 * envelope data that is not plain JSON: compilation never repairs.
 */
export function compilePaymentIntent(raw: PaymentIntent, binding: PaymentGovernanceBinding, envelope: PaymentEnvelopeOptions = {}): PaymentGovernedActionIntent {
  // Read once, checked once, compiled from the same snapshot (review P2).
  const intent = snapshotPaymentIntent(raw);
  if (intent === undefined) throw new RangeError('compilePaymentIntent needs a payment intent validatePaymentIntent accepted.');
  const action: unknown = binding !== null && typeof binding === 'object' ? (binding as { readonly action?: unknown }).action : undefined;
  if (!isPaymentEnvelopeIdentifier(action)) throw new PaymentConfigurationError('The payment governance binding is not canonical.');
  const parameters: Record<string, string> = { [PAYMENT_PARAMETER_DIMENSION_IDS.purpose]: intent.purpose };
  if (intent.reference !== undefined) parameters[PAYMENT_PARAMETER_DIMENSION_IDS.reference] = intent.reference;
  if (intent.rail !== undefined) parameters[PAYMENT_PARAMETER_DIMENSION_IDS.rail] = intent.rail;
  const options = readEnvelopeOptions(envelope);
  const assertedContext = options.assertedContext === undefined ? undefined : (snapshotEnvelopeValue(options.assertedContext, 0) as Readonly<Record<string, unknown>>);
  if (assertedContext !== undefined && (assertedContext === null || typeof assertedContext !== 'object' || Array.isArray(assertedContext))) throw new RangeError('assertedContext must be a plain object.');
  const expectedGovernanceProfile = options.expectedGovernanceProfile === undefined ? undefined : snapshotProfileExpectation(options.expectedGovernanceProfile);
  return Object.freeze({
    action,
    resource: intent.source.accountId,
    counterparty: paymentCounterpartyOf(intent.destination),
    amount: Object.freeze({ value: intent.amount.value, currency: intent.amount.unit }),
    parameters: Object.freeze(parameters),
    idempotencyKey: intent.idempotencyKey,
    ...(intent.correlationId !== undefined ? { correlationId: intent.correlationId } : {}),
    ...(assertedContext !== undefined ? { assertedContext } : {}),
    ...(expectedGovernanceProfile !== undefined ? { expectedGovernanceProfile } : {}),
  });
}
