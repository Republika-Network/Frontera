import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import type { GovernedActionAmount, GovernedActionIntent } from './contracts.js';

/**
 * Canonicalizes an untrusted governed-action intent, or refuses it.
 *
 * **Closed, not filtered.** An intent is refused — never trimmed into a valid
 * one — when it carries any property this contract does not declare. That is
 * what makes "caller intent cannot override identity" a property of the
 * validator rather than of the orchestrator's discipline: `actorId`,
 * `organizationId`, `system`, `grantId`, `executionId` and every other
 * identity- or authority-shaped key are simply not in the vocabulary, so their
 * presence is a malformed request rather than an ignored one.
 *
 * The result is a fresh, frozen object built from the declared fields only, so
 * no reference to the caller's object — or to anything hanging off it — is
 * carried into the Kernel request.
 */
export type GovernedActionIntentValidation =
  | { readonly valid: true; readonly intent: GovernedActionIntent }
  | { readonly valid: false; readonly violations: readonly string[] };

const DECLARED_KEYS: ReadonlySet<string> = new Set(['action', 'resource', 'counterparty', 'amount', 'assertedContext', 'correlationId', 'idempotencyKey']);

/**
 * Keys an asserted context may not carry at its top level.
 *
 * The context reaches the Kernel as evidence to verify, and the Kernel already
 * binds actor and organization from their own request fields. These are
 * refused anyway, as defence in depth: a context bag is the one place a caller
 * could otherwise *spell* an identity or an authority, and nothing legitimate
 * needs to.
 */
export const GOVERNED_ACTION_RESERVED_CONTEXT_KEYS: readonly string[] = [
  'actor',
  'actorId',
  'organization',
  'organizationId',
  'principal',
  'principalId',
  'system',
  'externalSubject',
  'credential',
  'authorization',
  'grant',
  'grantId',
  'boundedGrantId',
  'grantExpiresAt',
  'authorityBinding',
  'adapter',
  'adapterId',
  'url',
  'executionId',
  'requestId',
  'decisionId',
  // P7: aggregate / velocity exercise controls are trusted host composition.
  // A caller can neither name nor suggest a limit, bucket, budget, window,
  // reservation or binding digest — at the top level (undeclared keys are
  // refused already) or inside asserted context.
  'exerciseControls',
  'aggregateControls',
  'limit',
  'limits',
  'limitId',
  'scopeKey',
  'quota',
  'budget',
  'velocity',
  'window',
  'windowSeconds',
  'maximum',
  'maxCount',
  'maxAmount',
  'reservation',
  'reservationId',
  'authorityBindingDigest',
];

const MAX_CONTEXT_DEPTH = 8;
const MAX_CONTEXT_KEYS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** JSON-safe, bounded, and free of anything that is not data. */
function isContextValue(value: unknown, depth: number): boolean {
  if (depth > MAX_CONTEXT_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= MAX_CONTEXT_KEYS && value.every((item) => isContextValue(item, depth + 1));
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    return keys.length <= MAX_CONTEXT_KEYS && keys.every((key) => isContextValue(value[key], depth + 1));
  }
  return false;
}

/**
 * Deep copy of an already-validated context value, so the caller's object is
 * never retained.
 *
 * Every key is *defined*, never assigned: an own `__proto__` key is ordinary
 * JSON data, and `out[key] = value` would invoke the legacy prototype setter
 * instead — dropping the value from the request and its digest, and replacing
 * the copy's prototype.
 */
function copyContextValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(copyContextValue));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: copyContextValue(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return Object.freeze(out);
  }
  return value;
}

function validateAmount(value: unknown, violations: string[]): GovernedActionAmount | undefined {
  if (!isPlainObject(value)) {
    violations.push('amount must be an object with value and currency.');
    return undefined;
  }
  const extra = Object.keys(value).filter((key) => key !== 'value' && key !== 'currency');
  if (extra.length > 0) violations.push(`amount carries undeclared properties: ${extra.join(', ')}.`);
  const amountValue = value['value'];
  const currency = value['currency'];
  if (typeof amountValue !== 'number' || !Number.isFinite(amountValue) || amountValue < 0) violations.push('amount.value must be a finite, non-negative number.');
  if (!isCanonicalCustomerIdentifier(currency)) violations.push('amount.currency must be a canonical identifier.');
  if (extra.length > 0 || typeof amountValue !== 'number' || !Number.isFinite(amountValue) || amountValue < 0 || !isCanonicalCustomerIdentifier(currency)) return undefined;
  return Object.freeze({ value: amountValue, currency });
}

export function validateGovernedActionIntent(raw: unknown): GovernedActionIntentValidation {
  if (!isPlainObject(raw)) return { valid: false, violations: ['The intent must be a plain object.'] };

  const violations: string[] = [];
  const undeclared = Object.keys(raw).filter((key) => !DECLARED_KEYS.has(key));
  if (undeclared.length > 0) violations.push(`The intent carries undeclared properties: ${undeclared.join(', ')}.`);

  const { action, resource, counterparty, amount, assertedContext, correlationId, idempotencyKey } = raw;

  if (!isCanonicalCustomerIdentifier(action)) violations.push('action must be a canonical identifier.');
  if (!isCanonicalCustomerIdentifier(resource)) violations.push('resource must be a canonical identifier.');
  if (!isCanonicalCustomerIdentifier(idempotencyKey)) violations.push('idempotencyKey is required and must be a canonical identifier.');
  if (counterparty !== undefined && !isCanonicalCustomerIdentifier(counterparty)) violations.push('counterparty must be a canonical identifier.');
  if (correlationId !== undefined && !isCanonicalCustomerIdentifier(correlationId)) violations.push('correlationId must be a canonical identifier.');

  const canonicalAmount = amount === undefined ? undefined : validateAmount(amount, violations);

  let canonicalContext: Readonly<Record<string, unknown>> | undefined;
  if (assertedContext !== undefined) {
    if (!isPlainObject(assertedContext) || !isContextValue(assertedContext, 0)) {
      violations.push(`assertedContext must be a plain JSON object of at most ${MAX_CONTEXT_KEYS} keys per level and depth ${MAX_CONTEXT_DEPTH}.`);
    } else {
      const reserved = Object.keys(assertedContext).filter((key) => GOVERNED_ACTION_RESERVED_CONTEXT_KEYS.includes(key));
      if (reserved.length > 0) violations.push(`assertedContext may not carry identity or authority keys: ${reserved.join(', ')}.`);
      else canonicalContext = copyContextValue(assertedContext) as Readonly<Record<string, unknown>>;
    }
  }

  if (violations.length > 0) return { valid: false, violations };

  return {
    valid: true,
    intent: Object.freeze({
      action: action as string,
      resource: resource as string,
      idempotencyKey: idempotencyKey as string,
      ...(counterparty !== undefined ? { counterparty: counterparty as string } : {}),
      ...(canonicalAmount !== undefined ? { amount: canonicalAmount } : {}),
      ...(canonicalContext !== undefined ? { assertedContext: canonicalContext } : {}),
      ...(correlationId !== undefined ? { correlationId: correlationId as string } : {}),
    }),
  };
}
