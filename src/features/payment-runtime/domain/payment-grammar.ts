import { isRecordableProviderRef } from '../../execution-runtime/index.js';

/**
 * The grammars every payment reference is held to (PAY-01).
 *
 * A payment names things that live outside Frontera: an account funds leave
 * from, a destination they go to, the business reference they settle. Each is
 * an **opaque identifier** here — Frontera never parses one into a rail's own
 * structure — so the only questions are whether it is bounded, whether it has
 * exactly one spelling, and whether it could be something other than an
 * identifier: a path, a URL, a credential, a key. Everything that fails is
 * refused, never repaired.
 */

/** An account or destination reference: a letter or digit, then letters, digits and `.`, `_`, `:`, `@`, `+`, `=`, `-`. No whitespace, no `/` or `\`, nothing a path, URL or shell could reinterpret. */
const PAYMENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@+=-]*$/;

/** At most this many characters per account or destination reference. */
export const PAYMENT_REFERENCE_MAXIMUM_LENGTH = 200;

/** A destination kind: lowercase words joined by single hyphens — `account`, `beneficiary`, `payment-address`. */
const PAYMENT_DESTINATION_KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** At most this many characters per destination kind. */
export const PAYMENT_DESTINATION_KIND_MAXIMUM_LENGTH = 32;

/** An envelope identifier (idempotency key, correlation id, action): non-empty, bounded, trim-stable, control-character-free — the envelope's own rule. */
export const PAYMENT_ENVELOPE_IDENTIFIER_MAXIMUM_LENGTH = 256;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Whether a value is an opaque account or destination reference.
 *
 * Beyond the grammar, a value shaped like a credential — a JWT, a bearer or
 * basic credential, a PEM block, a URL — is refused even where the grammar
 * would admit it, using the execution runtime's one rule for what may be
 * carried as an opaque reference (`isRecordableProviderRef`). A reference is
 * policy input and durable evidence; it may never be a secret.
 */
export function isPaymentReference(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PAYMENT_REFERENCE_MAXIMUM_LENGTH && PAYMENT_REFERENCE.test(value) && isRecordableProviderRef(value);
}

export function isPaymentDestinationKind(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PAYMENT_DESTINATION_KIND_MAXIMUM_LENGTH && PAYMENT_DESTINATION_KIND.test(value);
}

export function isPaymentEnvelopeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= PAYMENT_ENVELOPE_IDENTIFIER_MAXIMUM_LENGTH && value === value.trim() && !CONTROL.test(value);
}

/**
 * Property names that announce secret material.
 *
 * A payment contract is closed, so any of these is already an undeclared
 * property; they are named separately so the refusal says *why*, and so the
 * violation can never be mistaken for a typo. The value is never read.
 */
const SECRET_PROPERTY = /(secret|password|passphrase|private_?key|privatekey|signing_?key|mnemonic|seed|credential|bearer|api_?key|authorization|access_?token|refresh_?token)/i;

export function isSecretShapedPropertyName(name: string): boolean {
  return SECRET_PROPERTY.test(name);
}

/** A property name safe to repeat in a violation: short and printable. Anything else is reported as `<property>`. */
export function reportablePropertyName(name: string): string {
  return /^[A-Za-z0-9_.-]{1,64}$/.test(name) ? name : '<property>';
}

export function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
