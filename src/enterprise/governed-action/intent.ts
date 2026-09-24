import { isPositiveMonetaryAmount, parseMonetaryAmount, type MonetaryAmount } from '../../features/monetary-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import type { ClassifiedGovernedActionIntent, GovernedActionMonetaryTrust } from './contracts.js';

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
 *
 * **Classified, not trusted to classify itself (P9).** Whether the action is
 * financial is the host's `actionClassifier`'s answer about `action`; there is
 * no intent field for it, and a `financial`/`actionClass`/`scale` key is an
 * undeclared property like any other. A financial action must carry an exact
 * amount — decimal text, strictly positive, in an asset the host's registry
 * recognizes, within that asset's trusted scale — and a non-financial action
 * must carry none.
 */
export type GovernedActionIntentValidation =
  | { readonly valid: true; readonly intent: ClassifiedGovernedActionIntent }
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
  // P9: the financial class and an asset's scale are trusted host
  // configuration. A caller can neither state nor contradict them — not at the
  // top level (undeclared keys are refused already) and not here.
  'financial',
  'actionClass',
  'classification',
  'scale',
  'assetScale',
  // P10: payment ceilings and durable spending limits are authority state,
  // provisioned by an operator into the Kernel Authority Store. A caller can
  // neither state, raise, select nor suggest one — not here, and not at the
  // top level, where undeclared keys are refused already.
  'max_amount',
  'paymentCeiling',
  'ceiling',
  'spendingLimit',
  'spendingLimits',
  'spending_limit',
  'budgetId',
  'remaining',
  'financialAuthority',
  'authorityLimit',
  'authorityRef',
  'constraints',
  // P11: provider certainty and execution outcomes are observed by the
  // execution runtime from the adapter's normalized result — never reported by
  // a caller. A caller can neither state a provider reference, a provider
  // status, a certainty nor an execution outcome — not here, and not at the top
  // level, where undeclared keys are refused already.
  'providerRef',
  'providerStatus',
  'providerCertainty',
  'certainty',
  'executionOutcome',
  'executionStatus',
  'outcomeRecorded',
  // P12: a resolution is established only by the execution's durably bound,
  // host-trusted resolution authority, through the trusted in-process
  // reconciliation service. A caller can neither state a resolution, name or
  // impersonate a resolution authority, nor report a final provider outcome —
  // not here, and not at the top level, where undeclared keys are refused
  // already.
  'resolution',
  'resolved',
  'reconciled',
  'reconciliation',
  'resolutionAuthority',
  'resolutionAuthorityId',
  'providerResolution',
  'providerOutcome',
  'finalOutcome',
  'confirmedCompleted',
  'confirmedNotCompleted',
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

function validateAmount(value: unknown, trust: GovernedActionMonetaryTrust, violations: string[]): MonetaryAmount | undefined {
  if (!isPlainObject(value)) {
    violations.push('amount must be an object with value and currency.');
    return undefined;
  }
  const extra = Object.keys(value).filter((key) => key !== 'value' && key !== 'currency');
  if (extra.length > 0) {
    violations.push(`amount carries undeclared properties: ${extra.join(', ')}.`);
    return undefined;
  }
  const parsed = parseMonetaryAmount({ value: value['value'], unit: value['currency'] }, trust.assets);
  if (!parsed.valid) {
    violations.push(AMOUNT_VIOLATION_MESSAGES[parsed.violation]);
    return undefined;
  }
  return parsed.amount;
}

/** Explicit, and free of anything internal: no scale, no registry contents, no stack. */
const AMOUNT_VIOLATION_MESSAGES = {
  MONETARY_VALUE_NOT_TEXT: 'amount.value must be decimal text, not a number.',
  MONETARY_VALUE_MALFORMED: 'amount.value must be a plain non-negative decimal: digits, an optional fractional part, no sign, exponent, separator, whitespace or leading zero.',
  MONETARY_UNIT_UNKNOWN: 'amount.currency is not an asset this deployment recognizes.',
  MONETARY_SCALE_EXCEEDED: 'amount.value states more fractional digits than amount.currency allows; it is refused, never rounded.',
} as const;

export function validateGovernedActionIntent(raw: unknown, trust: GovernedActionMonetaryTrust): GovernedActionIntentValidation {
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

  const canonicalAmount = amount === undefined ? undefined : validateAmount(amount, trust, violations);

  // The class is the host's answer about `action`, never the intent's. It is
  // read only once the action is known to be a canonical identifier.
  const actionClass = isCanonicalCustomerIdentifier(action) ? trust.actionClassifier.classify(action) : 'non-financial';
  if (actionClass === 'financial' && amount === undefined) violations.push('This action moves money and requires an amount.');
  if (actionClass === 'financial' && canonicalAmount !== undefined && !isPositiveMonetaryAmount(canonicalAmount)) violations.push('amount.value must be greater than zero.');
  if (actionClass === 'non-financial' && amount !== undefined) violations.push('This action does not move money and may not carry an amount.');

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

  const common = {
    action: action as string,
    resource: resource as string,
    idempotencyKey: idempotencyKey as string,
    ...(counterparty !== undefined ? { counterparty: counterparty as string } : {}),
    ...(canonicalContext !== undefined ? { assertedContext: canonicalContext } : {}),
    ...(correlationId !== undefined ? { correlationId: correlationId as string } : {}),
  };
  const intent: ClassifiedGovernedActionIntent =
    actionClass === 'financial' && canonicalAmount !== undefined ? { ...common, actionClass, amount: canonicalAmount } : { ...common, actionClass: 'non-financial' };
  return { valid: true, intent: Object.freeze(intent) };
}
