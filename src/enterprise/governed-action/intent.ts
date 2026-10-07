import {
  GOVERNED_PARAMETERS_MAX,
  compareDimensionIds,
  isGovernanceProfileVersion,
  isSemanticIdentifier,
  parseGovernedParameterValue,
  type DeclaredGovernedParameter,
  type GovernedActionSemantics,
} from '../../features/governed-parameter-runtime/index.js';
import { isPositiveMonetaryAmount, parseMonetaryAmount, type MonetaryAmount } from '../../features/monetary-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/index.js';
import type { GovernanceProfileRegistry, ResolvedGovernanceProfile } from '../governance-profile/index.js';
import type { ClassifiedGovernedActionIntent, GovernedActionMonetaryTrust } from './contracts.js';
import { RECONSIDERATION_REASONS, isReconsiderationReason, type ReconsiderationIntent } from './reconsideration-lineage.js';
import { monetaryIngressFromWire } from './monetary-naming.js';

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
 *
 * **Semantically classified by trusted configuration, never by the caller
 * (CORE-03).** The trusted Governance Profile registry resolves `action` ×
 * `resource` to an action class, a resource class and one versioned profile.
 * Typed `parameters` are accepted only for dimensions that profile declares,
 * parsed strictly by the dimension's declared type, and required ones must be
 * present; an action no profile governs may carry no parameters and may expect
 * no profile. A half-classified pair, or a classified pair no profile governs,
 * is refused — never quietly evaluated as if unclassified.
 */
export type GovernedActionIntentValidation =
  | { readonly valid: true; readonly intent: ClassifiedGovernedActionIntent }
  | { readonly valid: false; readonly violations: readonly string[] };

const DECLARED_KEYS: ReadonlySet<string> = new Set(['action', 'resource', 'counterparty', 'amount', 'parameters', 'expectedGovernanceProfile', 'assertedContext', 'correlationId', 'idempotencyKey', 'reconsideration']);
/** The shape of a governed request id (`identifiers.ts`). */
const GOVERNED_REQUEST_ID = /^aoc\.gar:[0-9a-f]{32}$/;

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
  // CORE-03: the semantic classification and the typed parameters are the
  // trusted resolver's and the declared `parameters` field's — never a context
  // claim. (Declared dimension ids themselves are refused here too, whenever a
  // registry declares them; see `validateGovernedActionIntent`.)
  'resourceClass',
  'governanceProfile',
  'expectedGovernanceProfile',
  'governedParameters',
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
  const parsed = parseMonetaryAmount(monetaryIngressFromWire(value), trust.assets);
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

/** The resolution an absent registry gives: nothing is classified, which is the pre-CORE-03 world exactly. */
const UNCLASSIFIED = { kind: 'unclassified' } as const;

/**
 * The declared, typed parameter list for one resolved profile, or `undefined`
 * when there is nothing to carry. Every violation is reported; nothing is
 * coerced, defaulted or dropped silently.
 */
function validateParameters(raw: unknown, profile: ResolvedGovernanceProfile, governance: GovernanceProfileRegistry, violations: string[]): readonly DeclaredGovernedParameter[] | undefined {
  if (raw !== undefined && !isPlainObject(raw)) {
    violations.push('parameters must be a plain object keyed by declared dimension id.');
    return undefined;
  }
  const supplied: Record<string, unknown> = raw ?? {};
  const keys = Object.keys(supplied);
  if (keys.length > GOVERNED_PARAMETERS_MAX) {
    violations.push(`parameters may state at most ${GOVERNED_PARAMETERS_MAX} dimensions.`);
    return undefined;
  }
  const governed = new Set(profile.definition.parameters.map((parameter) => parameter.dimension));
  // Exact names only. A differently-cased key is a different, undeclared name —
  // never a second spelling of a declared one.
  const undeclared = keys.filter((key) => !governed.has(key));
  if (undeclared.length > 0) violations.push(`parameters carries dimensions the governing profile does not declare: ${undeclared.join(', ')}.`);

  const declared: DeclaredGovernedParameter[] = [];
  for (const parameter of profile.definition.parameters) {
    if (!Object.prototype.hasOwnProperty.call(supplied, parameter.dimension)) {
      // Absent is its own state — not null, not zero, not empty, not false.
      if (parameter.required) violations.push(`parameters.${parameter.dimension} is required by the governing profile.`);
      continue;
    }
    const dimension = governance.dimensions.get(parameter.dimension);
    if (dimension === undefined) {
      // Unreachable: the registry refused a profile naming an undeclared dimension.
      violations.push(`parameters.${parameter.dimension} has no trusted declaration.`);
      continue;
    }
    const parsed = parseGovernedParameterValue(dimension.type, supplied[parameter.dimension]);
    if (!parsed.valid) {
      violations.push(`parameters.${parameter.dimension} must be a ${dimension.type} (${parsed.violation}).`);
      continue;
    }
    declared.push({ dimension: parameter.dimension, bound: dimension.bound, ...parsed.value } as DeclaredGovernedParameter);
  }
  declared.sort((left, right) => compareDimensionIds(left.dimension, right.dimension));
  return declared.length > 0 ? Object.freeze(declared.map((entry) => Object.freeze(entry))) : undefined;
}

/** A caller's `{ id, version }` expectation against the profile the trusted resolver chose. Pinning is allowed; choosing is not. */
function validateProfileExpectation(raw: unknown, profile: ResolvedGovernanceProfile, violations: string[]): void {
  if (!isPlainObject(raw) || Object.keys(raw).some((key) => key !== 'id' && key !== 'version') || !isSemanticIdentifier(raw['id']) || !isGovernanceProfileVersion(raw['version'])) {
    violations.push('expectedGovernanceProfile must be exactly { id, version }: a semantic identifier and a positive integer.');
    return;
  }
  if (raw['id'] !== profile.reference.id || raw['version'] !== profile.reference.version) {
    violations.push('expectedGovernanceProfile does not match the effective profile trusted configuration resolves for this action and resource; it can be pinned, never chosen.');
  }
}

export function validateGovernedActionIntent(raw: unknown, trust: GovernedActionMonetaryTrust, governance?: GovernanceProfileRegistry): GovernedActionIntentValidation {
  if (!isPlainObject(raw)) return { valid: false, violations: ['The intent must be a plain object.'] };

  const violations: string[] = [];
  const undeclared = Object.keys(raw).filter((key) => !DECLARED_KEYS.has(key));
  if (undeclared.length > 0) violations.push(`The intent carries undeclared properties: ${undeclared.join(', ')}.`);

  const { action, resource, counterparty, amount, parameters, expectedGovernanceProfile, assertedContext, correlationId, idempotencyKey, reconsideration } = raw;

  // LAND-01: a closed `{ of, reason }` — the original's request id and why governance state changed.
  let canonicalReconsideration: ReconsiderationIntent | undefined;
  if (reconsideration !== undefined) {
    if (!isPlainObject(reconsideration) || Object.keys(reconsideration).some((key) => key !== 'of' && key !== 'reason')) {
      violations.push('reconsideration must be an object with exactly `of` and `reason`.');
    } else if (typeof reconsideration['of'] !== 'string' || !GOVERNED_REQUEST_ID.test(reconsideration['of'])) {
      violations.push('reconsideration.of must be a governed request id (aoc.gar:<32 lowercase hex>).');
    } else if (!isReconsiderationReason(reconsideration['reason'])) {
      violations.push(`reconsideration.reason must be one of: ${RECONSIDERATION_REASONS.join(', ')}.`);
    } else {
      canonicalReconsideration = Object.freeze({ of: reconsideration['of'], reason: reconsideration['reason'] });
    }
  }

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

  // CORE-03: the trusted semantic classification. Read only once both axes are
  // known canonical identifiers, and only from the host's registry.
  let semantics: GovernedActionSemantics | undefined;
  let declaredParameters: readonly DeclaredGovernedParameter[] | undefined;
  if (isCanonicalCustomerIdentifier(action) && isCanonicalCustomerIdentifier(resource)) {
    const resolution = governance?.resolve(action, resource) ?? UNCLASSIFIED;
    if (resolution.kind === 'refused') {
      violations.push(`This action and resource are not governed by any trusted Governance Profile (${resolution.reason}).`);
    } else if (resolution.kind === 'unclassified') {
      if (parameters !== undefined) violations.push('No Governance Profile governs this action, so it may carry no parameters.');
      if (expectedGovernanceProfile !== undefined) violations.push('No Governance Profile governs this action, so no expectedGovernanceProfile can be met.');
    } else if (governance !== undefined) {
      // The effective profile is the resolver's, full stop. The caller's
      // expectation is only compared against it: it can pin, never choose.
      if (expectedGovernanceProfile !== undefined) validateProfileExpectation(expectedGovernanceProfile, resolution.profile, violations);
      declaredParameters = validateParameters(parameters, resolution.profile, governance, violations);
      semantics = resolution.semantics;
    }
  }

  let canonicalContext: Readonly<Record<string, unknown>> | undefined;
  if (assertedContext !== undefined) {
    if (!isPlainObject(assertedContext) || !isContextValue(assertedContext, 0)) {
      violations.push(`assertedContext must be a plain JSON object of at most ${MAX_CONTEXT_KEYS} keys per level and depth ${MAX_CONTEXT_DEPTH}.`);
    } else {
      // The reserved-key registry: the built-in list above, plus the keys
      // trusted configuration registers (verticals extend it; L-7) and every
      // declared dimension id — both in any case. One canonical value per
      // dimension, and it is the declared parameter's.
      const reserved = Object.keys(assertedContext).filter((key) => GOVERNED_ACTION_RESERVED_CONTEXT_KEYS.includes(key) || governance?.reservesContextKey(key) === true);
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
    ...(semantics !== undefined ? { semantics } : {}),
    ...(declaredParameters !== undefined ? { parameters: declaredParameters } : {}),
    ...(canonicalContext !== undefined ? { assertedContext: canonicalContext } : {}),
    ...(correlationId !== undefined ? { correlationId: correlationId as string } : {}),
    ...(canonicalReconsideration !== undefined ? { reconsideration: canonicalReconsideration } : {}),
  };
  const intent: ClassifiedGovernedActionIntent =
    actionClass === 'financial' && canonicalAmount !== undefined ? { ...common, actionClass, amount: canonicalAmount } : { ...common, actionClass: 'non-financial' };
  return { valid: true, intent: Object.freeze(intent) };
}
