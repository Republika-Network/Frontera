import type { CustomerExternalSubject } from './contracts.js';

/** Upper bound on every identifier admission accepts. Matches the `sourceId` bound the trusted context providers already apply. */
export const CUSTOMER_IDENTIFIER_MAX_LENGTH = 256;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

/**
 * Whether `value` is an identifier admission may carry.
 *
 * Refused rather than repaired: an identifier with surrounding whitespace is
 * not trimmed into a different one, because two spellings that normalize to
 * the same principal are two configurations that disagree, and silently
 * picking one is how an identity drifts. Non-empty, bounded, canonical
 * (trim-stable) and free of control characters.
 */
export function isCanonicalCustomerIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CUSTOMER_IDENTIFIER_MAX_LENGTH &&
    value === value.trim() &&
    !CONTROL.test(value)
  );
}

export function isCanonicalCustomerExternalSubject(value: unknown): value is CustomerExternalSubject {
  if (value === null || typeof value !== 'object') return false;
  const { system, subjectId } = value as Record<string, unknown>;
  return isCanonicalCustomerIdentifier(system) && isCanonicalCustomerIdentifier(subjectId);
}
