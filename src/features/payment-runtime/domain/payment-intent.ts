import { isPositiveMonetaryAmount, isWellFormedMonetaryAmount, parseMonetaryAmount, type MonetaryAmount, type MonetaryAssetRegistry } from '../../monetary-runtime/index.js';
import {
  isPaymentBusinessReference,
  isPaymentDestinationKind,
  isPaymentEnvelopeIdentifier,
  isPaymentRailId,
  isPaymentReference,
  isPlainRecord,
  isSecretShapedPropertyName,
  reportablePropertyName,
} from './payment-grammar.js';

/**
 * The canonical payment intent (PAY-01).
 *
 * > **What is a payment, from Frontera's governance perspective, before any
 * > specific rail executes it?**
 *
 * A request to move an exact amount of one recognized asset, from an account
 * this deployment governs, to a stated destination, for a stated purpose —
 * and nothing else. It is **not** a second governed-action model: it carries
 * only what is payment-specific, and it compiles down to the unchanged
 * `GovernedActionIntent` envelope (`payment-governance.ts`), which owns
 * everything generic.
 *
 * ## What the envelope owns, and this contract therefore does not carry
 *
 * | concern | owner |
 * | --- | --- |
 * | who requests it (actor, principal, organization) | the bound customer identity — never request data |
 * | when it was requested | the orchestrator's clock |
 * | the payment's identity | the governed request id, derived from `idempotencyKey` scoped to `(organization, principal)` |
 * | authority, ceilings, cumulative exposure | Kernel Authority (P10) and exercise controls (P7) |
 * | the decision, approval, obligations, grant | the Kernel and the governed path |
 * | which rail executes it | trusted server-side adapter routing |
 *
 * A caller who attaches any of those — or anything else this contract does not
 * declare — is refused, not quietly trimmed.
 *
 * ## No free-form metadata
 *
 * There is deliberately no `metadata` bag and no memo. Every value a payment
 * carries reaches policy as a typed axis and, if granted, reaches the rail
 * only as a value the grant bounded (`ADR-PROVIDER-ADAPTER-CONTRACT.md`,
 * `execution-adapter-port.ts`: no free-form payload crosses the execution
 * boundary). A bag would be a channel no bound covers. A business reference
 * that needs to travel with the payment is `reference`, a bounded token the
 * grant binds exactly.
 */
export interface PaymentIntent {
  /** The governed account funds leave from. */
  readonly source: PaymentSourceRef;
  /** Where funds go. */
  readonly destination: PaymentDestination;
  /** An exact P9 amount: canonical decimal text in a recognized asset, within its trusted scale, strictly positive. */
  readonly amount: MonetaryAmount;
  /** Why the payment is made, from a closed vocabulary policy can read. */
  readonly purpose: PaymentPurpose;
  /** The caller's own business reference (an invoice number, a batch id). A governed token, bound exactly by the grant. */
  readonly reference?: string;
  /** A rail preference. A governed token the grant binds exactly; trusted routing may honour it, and a rail asked to execute a payment preferring another rail refuses before contacting anything. Never a selector by itself. */
  readonly rail?: string;
  /** Required. The envelope's idempotency key: the same key with the same payment replays; the same key with a different payment is refused. */
  readonly idempotencyKey: string;
  readonly correlationId?: string;
}

/**
 * The account a payment is drawn from — a reference to a resource this
 * deployment already governs, never a capability to spend from it. There is no
 * key, no signer, no credential and no rail-specific address form here: the
 * account id is the governed resource, and only a granted, trusted rail
 * composed by the host knows how to act on it.
 */
export interface PaymentSourceRef {
  readonly accountId: string;
}

/**
 * Where a payment goes — explicit, serializable and opaque.
 *
 * `kind` says what sort of reference `reference` is (`account`,
 * `beneficiary`, `payment-address`, …) in a host's own vocabulary; Frontera
 * gives it no meaning beyond its grammar, so a new rail needs no new kind
 * here. `reference` is an opaque identifier, never a secret, a URL or a
 * routing instruction. Whether a destination is *trusted* is policy's and
 * authority's question (the governed counterparty), never this contract's.
 */
export interface PaymentDestination {
  readonly kind: string;
  readonly reference: string;
}

/**
 * Why a payment is made. Closed, small and deliberately not an accounting
 * model: enough for deterministic policy to treat payroll differently from a
 * purchase, and nothing a bookkeeping system would need.
 */
export const PAYMENT_PURPOSES = ['vendor-payment', 'treasury-transfer', 'settlement', 'reimbursement', 'payroll', 'purchase', 'refund'] as const;

export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export function isPaymentPurpose(value: unknown): value is PaymentPurpose {
  return typeof value === 'string' && (PAYMENT_PURPOSES as readonly string[]).includes(value);
}

/** Machine-readable, deterministic, and free of any submitted value. */
export const PAYMENT_INTENT_VIOLATIONS = {
  PAYMENT_INTENT_NOT_OBJECT: 'PAYMENT_INTENT_NOT_OBJECT',
  /** A property this contract does not declare. Refused, never ignored. */
  PAYMENT_PROPERTY_UNDECLARED: 'PAYMENT_PROPERTY_UNDECLARED',
  /** A property whose name announces secret material (a key, a recovery phrase, a credential). Its value is never read. */
  PAYMENT_SECRET_MATERIAL_REFUSED: 'PAYMENT_SECRET_MATERIAL_REFUSED',
  /** A property defined by an accessor rather than a value: a getter is code, and could answer differently later. */
  PAYMENT_PROPERTY_NOT_DATA: 'PAYMENT_PROPERTY_NOT_DATA',
  PAYMENT_SOURCE_INVALID: 'PAYMENT_SOURCE_INVALID',
  PAYMENT_DESTINATION_INVALID: 'PAYMENT_DESTINATION_INVALID',
  PAYMENT_DESTINATION_KIND_INVALID: 'PAYMENT_DESTINATION_KIND_INVALID',
  PAYMENT_DESTINATION_REFERENCE_INVALID: 'PAYMENT_DESTINATION_REFERENCE_INVALID',
  /** `amount` is not exactly `{ value, unit }`. */
  PAYMENT_AMOUNT_INVALID: 'PAYMENT_AMOUNT_INVALID',
  /** `amount.value` is not text — a number in particular: its precision was decided by whoever parsed it. */
  PAYMENT_AMOUNT_NOT_TEXT: 'PAYMENT_AMOUNT_NOT_TEXT',
  /** `amount.value` is not a plain non-negative decimal: a sign, an exponent, a separator, whitespace, a leading zero, `NaN`, `Infinity`. */
  PAYMENT_AMOUNT_MALFORMED: 'PAYMENT_AMOUNT_MALFORMED',
  /** `amount.unit` is not an asset this deployment recognizes. */
  PAYMENT_ASSET_UNKNOWN: 'PAYMENT_ASSET_UNKNOWN',
  /** `amount.value` states more fractional digits than the asset's trusted scale. Refused, never rounded. */
  PAYMENT_AMOUNT_SCALE_EXCEEDED: 'PAYMENT_AMOUNT_SCALE_EXCEEDED',
  /** A payment of nothing is not a payment. */
  PAYMENT_AMOUNT_NOT_POSITIVE: 'PAYMENT_AMOUNT_NOT_POSITIVE',
  PAYMENT_PURPOSE_INVALID: 'PAYMENT_PURPOSE_INVALID',
  PAYMENT_REFERENCE_INVALID: 'PAYMENT_REFERENCE_INVALID',
  PAYMENT_RAIL_INVALID: 'PAYMENT_RAIL_INVALID',
  PAYMENT_IDEMPOTENCY_KEY_INVALID: 'PAYMENT_IDEMPOTENCY_KEY_INVALID',
  PAYMENT_CORRELATION_ID_INVALID: 'PAYMENT_CORRELATION_ID_INVALID',
} as const;

export type PaymentIntentViolationCode = (typeof PAYMENT_INTENT_VIOLATIONS)[keyof typeof PAYMENT_INTENT_VIOLATIONS];

/** One refusal: a code, and the path of the field it concerns. Never the submitted value. */
export interface PaymentIntentViolation {
  readonly code: PaymentIntentViolationCode;
  readonly field: string;
}

export type PaymentIntentValidation = { readonly valid: true; readonly intent: PaymentIntent } | { readonly valid: false; readonly violations: readonly PaymentIntentViolation[] };

/** The trusted configuration a payment intent is validated against. Host composition only — the same P9 registry the governed path holds. */
export interface PaymentIntentTrust {
  readonly assets: MonetaryAssetRegistry;
}

const INTENT_KEYS: readonly string[] = ['source', 'destination', 'amount', 'purpose', 'reference', 'rail', 'idempotencyKey', 'correlationId'];
const SOURCE_KEYS: readonly string[] = ['accountId'];
const DESTINATION_KEYS: readonly string[] = ['kind', 'reference'];
const AMOUNT_KEYS: readonly string[] = ['value', 'unit'];

const V = PAYMENT_INTENT_VIOLATIONS;

/** A closed record's declared data properties, and the declared names that could not be read. */
interface ClosedRead {
  readonly fields: Readonly<Record<string, unknown>>;
  /** Declared properties already refused (an accessor). Their own checks are skipped so each is reported once. */
  readonly unread: ReadonlySet<string>;
}

/**
 * Reads a closed record's declared data properties **once each**. Undeclared
 * names are refused (secret-shaped ones refused by name, their value never
 * read); an accessor is refused without being run. Declared data properties
 * are still returned beside those refusals, so one stray property does not
 * hide every other finding.
 */
function readClosed(raw: Readonly<Record<string, unknown>>, declared: readonly string[], path: string, violations: PaymentIntentViolation[]): ClosedRead {
  const fields: Record<string, unknown> = {};
  const unread = new Set<string>();
  for (const key of Reflect.ownKeys(raw)) {
    const name = typeof key === 'string' ? key : '<symbol>';
    const field = `${path}${reportablePropertyName(name)}`;
    if (typeof key !== 'string' || !declared.includes(key)) {
      violations.push({ code: typeof key === 'string' && isSecretShapedPropertyName(key) ? V.PAYMENT_SECRET_MATERIAL_REFUSED : V.PAYMENT_PROPERTY_UNDECLARED, field });
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) {
      violations.push({ code: V.PAYMENT_PROPERTY_NOT_DATA, field });
      unread.add(key);
      continue;
    }
    Object.defineProperty(fields, key, { value: descriptor.value as unknown, enumerable: true });
  }
  return { fields, unread };
}

function validateSource(raw: unknown, violations: PaymentIntentViolation[]): PaymentSourceRef | undefined {
  if (!isPlainRecord(raw)) {
    violations.push({ code: V.PAYMENT_SOURCE_INVALID, field: 'source' });
    return undefined;
  }
  const { fields, unread } = readClosed(raw, SOURCE_KEYS, 'source.', violations);
  if (unread.size > 0) return undefined;
  if (!isPaymentReference(fields['accountId'])) {
    violations.push({ code: V.PAYMENT_SOURCE_INVALID, field: 'source.accountId' });
    return undefined;
  }
  return Object.freeze({ accountId: fields['accountId'] });
}

function validateDestination(raw: unknown, violations: PaymentIntentViolation[]): PaymentDestination | undefined {
  if (!isPlainRecord(raw)) {
    violations.push({ code: V.PAYMENT_DESTINATION_INVALID, field: 'destination' });
    return undefined;
  }
  const { fields, unread } = readClosed(raw, DESTINATION_KEYS, 'destination.', violations);
  if (unread.size > 0) return undefined;
  const kind = fields['kind'];
  const reference = fields['reference'];
  let valid = true;
  if (!isPaymentDestinationKind(kind)) {
    violations.push({ code: V.PAYMENT_DESTINATION_KIND_INVALID, field: 'destination.kind' });
    valid = false;
  }
  if (!isPaymentReference(reference)) {
    violations.push({ code: V.PAYMENT_DESTINATION_REFERENCE_INVALID, field: 'destination.reference' });
    valid = false;
  }
  return valid ? Object.freeze({ kind: kind as string, reference: reference as string }) : undefined;
}

const AMOUNT_VIOLATION = {
  MONETARY_VALUE_NOT_TEXT: V.PAYMENT_AMOUNT_NOT_TEXT,
  MONETARY_VALUE_MALFORMED: V.PAYMENT_AMOUNT_MALFORMED,
  MONETARY_UNIT_UNKNOWN: V.PAYMENT_ASSET_UNKNOWN,
  MONETARY_SCALE_EXCEEDED: V.PAYMENT_AMOUNT_SCALE_EXCEEDED,
} as const;

/** The single P9 ingress, unchanged: no parallel decimal parser, no rounding, no unit conversion. Then strictly positive. */
function validateAmount(raw: unknown, trust: PaymentIntentTrust, violations: PaymentIntentViolation[]): MonetaryAmount | undefined {
  if (!isPlainRecord(raw)) {
    violations.push({ code: V.PAYMENT_AMOUNT_INVALID, field: 'amount' });
    return undefined;
  }
  const { fields, unread } = readClosed(raw, AMOUNT_KEYS, 'amount.', violations);
  if (unread.size > 0) return undefined;
  const parsed = parseMonetaryAmount({ value: fields['value'], unit: fields['unit'] }, trust.assets);
  if (!parsed.valid) {
    violations.push({ code: AMOUNT_VIOLATION[parsed.violation], field: parsed.violation === 'MONETARY_UNIT_UNKNOWN' ? 'amount.unit' : 'amount.value' });
    return undefined;
  }
  if (!isPositiveMonetaryAmount(parsed.amount)) {
    violations.push({ code: V.PAYMENT_AMOUNT_NOT_POSITIVE, field: 'amount.value' });
    return undefined;
  }
  return parsed.amount;
}

/**
 * Canonicalizes an untrusted payment intent, or refuses it. **Fail closed.**
 *
 * Every violation is reported, in a deterministic order, as a code and a
 * field path — never the offending value, so a refusal can be logged and
 * returned without echoing what a caller sent. The result is a fresh, frozen
 * object built from declared data properties only, with a canonical amount
 * (`"10.50"` becomes `"10.5"`), and no reference into the caller's object.
 *
 * Validation here is the payment's own well-formedness. It is **not** a
 * governance decision: whether this source may pay this destination this
 * amount is decided on the governed path, after compilation.
 */
export function validatePaymentIntent(raw: unknown, trust: PaymentIntentTrust): PaymentIntentValidation {
  if (!isPlainRecord(raw)) return { valid: false, violations: [{ code: V.PAYMENT_INTENT_NOT_OBJECT, field: '' }] };
  const violations: PaymentIntentViolation[] = [];
  const { fields, unread } = readClosed(raw, INTENT_KEYS, '', violations);
  const checked = (key: string): boolean => !unread.has(key);

  const source = checked('source') ? validateSource(fields['source'], violations) : undefined;
  const destination = checked('destination') ? validateDestination(fields['destination'], violations) : undefined;
  const amount = checked('amount') ? validateAmount(fields['amount'], trust, violations) : undefined;

  const purpose = fields['purpose'];
  if (checked('purpose') && !isPaymentPurpose(purpose)) violations.push({ code: V.PAYMENT_PURPOSE_INVALID, field: 'purpose' });
  const reference = fields['reference'];
  if (checked('reference') && reference !== undefined && !isPaymentBusinessReference(reference)) violations.push({ code: V.PAYMENT_REFERENCE_INVALID, field: 'reference' });
  const rail = fields['rail'];
  if (checked('rail') && rail !== undefined && !isPaymentRailId(rail)) violations.push({ code: V.PAYMENT_RAIL_INVALID, field: 'rail' });
  const idempotencyKey = fields['idempotencyKey'];
  if (checked('idempotencyKey') && !isPaymentEnvelopeIdentifier(idempotencyKey)) violations.push({ code: V.PAYMENT_IDEMPOTENCY_KEY_INVALID, field: 'idempotencyKey' });
  const correlationId = fields['correlationId'];
  if (checked('correlationId') && correlationId !== undefined && !isPaymentEnvelopeIdentifier(correlationId)) violations.push({ code: V.PAYMENT_CORRELATION_ID_INVALID, field: 'correlationId' });

  if (violations.length > 0 || source === undefined || destination === undefined || amount === undefined) {
    return { valid: false, violations: Object.freeze(violations.map((violation) => Object.freeze(violation))) };
  }
  return {
    valid: true,
    intent: Object.freeze({
      source,
      destination,
      amount,
      purpose: purpose as PaymentPurpose,
      ...(reference !== undefined ? { reference: reference as string } : {}),
      ...(rail !== undefined ? { rail: rail as string } : {}),
      idempotencyKey: idempotencyKey as string,
      ...(correlationId !== undefined ? { correlationId: correlationId as string } : {}),
    }),
  };
}

/** A closed record's own data properties, each read once into a fresh frozen copy — or `undefined` for anything else (an accessor, an undeclared key, a non-plain object). */
function snapshotClosed(value: unknown, declared: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !declared.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    if (descriptor.value !== undefined) Object.defineProperty(out, key, { value: descriptor.value as unknown, enumerable: true });
  }
  return Object.freeze(out);
}

/**
 * A canonical payment intent read **once** into a fresh, frozen snapshot, or
 * `undefined` when it is not one.
 *
 * What compilation consumes. Every property at every level is read exactly
 * once as a data property — an accessor is refused, never run — and the
 * well-formedness check runs on the snapshot, so nothing a caller's object
 * does later can make the compiled payment differ from the value checked.
 */
export function snapshotPaymentIntent(value: unknown): PaymentIntent | undefined {
  const intent = snapshotClosed(value, INTENT_KEYS);
  if (intent === undefined) return undefined;
  const source = snapshotClosed(intent['source'], SOURCE_KEYS);
  const destination = snapshotClosed(intent['destination'], DESTINATION_KEYS);
  const amount = snapshotClosed(intent['amount'], AMOUNT_KEYS);
  if (source === undefined || destination === undefined || amount === undefined) return undefined;
  const snapshot = Object.freeze({ ...intent, source, destination, amount });
  return isWellFormedPaymentIntent(snapshot) ? snapshot : undefined;
}

/**
 * Whether a value is structurally a canonical payment intent — the fail-closed
 * re-check for a value that reaches compilation without having come from
 * `validatePaymentIntent`. Registry-free, as P9's own downstream re-check is.
 */
export function isWellFormedPaymentIntent(value: unknown): value is PaymentIntent {
  if (!isPlainRecord(value)) return false;
  if (Object.keys(value).some((key) => !INTENT_KEYS.includes(key))) return false;
  const source = value['source'];
  const destination = value['destination'];
  const amount = value['amount'];
  return (
    isPlainRecord(source) &&
    Object.keys(source).length === 1 &&
    isPaymentReference(source['accountId']) &&
    isPlainRecord(destination) &&
    Object.keys(destination).length === 2 &&
    isPaymentDestinationKind(destination['kind']) &&
    isPaymentReference(destination['reference']) &&
    isPlainRecord(amount) &&
    Object.keys(amount).length === 2 &&
    isWellFormedMonetaryAmount(amount) &&
    isPositiveMonetaryAmount(amount) &&
    isPaymentPurpose(value['purpose']) &&
    (value['reference'] === undefined || isPaymentBusinessReference(value['reference'])) &&
    (value['rail'] === undefined || isPaymentRailId(value['rail'])) &&
    isPaymentEnvelopeIdentifier(value['idempotencyKey']) &&
    (value['correlationId'] === undefined || isPaymentEnvelopeIdentifier(value['correlationId']))
  );
}
