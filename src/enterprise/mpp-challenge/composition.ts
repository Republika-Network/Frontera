import { parseMonetaryAmount, isPositiveMonetaryAmount, type MonetaryAssetRegistry } from '../../features/monetary-runtime/index.js';
import { isCanonicalCustomerIdentifier } from '../customer-identity/identifiers.js';
import type {
  MppChallengeMethodNormalizer,
  MppChallengeSelectionContext,
  MppChallengeSelector,
  MppCounterpartyResolutionContext,
  MppCounterpartyResolver,
  MppNormalizedCharge,
  ProtectedMppRequest,
  SupportedMppChallenge,
} from './contracts.js';
import type { ParsedMppPaymentChallenge } from './protocol.js';

/** Raised while **composing** MPP challenge payments, never while handling one. There is no weaker mode to fall back to. */
export class MppChallengeConfigurationError extends Error {
  readonly code = 'MPP_CHALLENGE_CONFIGURATION_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'MppChallengeConfigurationError';
  }
}

/** The draft's `payment-method-id = 1*LOWERALPHA`. */
const METHOD_ID = /^[a-z]{1,64}$/;

/** One composed normalizer, snapshotted: identity and `normalize` as they were at composition. */
interface ComposedMethodNormalizer {
  readonly methodId: string;
  readonly intent: 'charge';
  readonly normalize: (challenge: ParsedMppPaymentChallenge, protectedRequest: ProtectedMppRequest) => unknown;
}

/** The frozen composition-time snapshot: normalizers keyed by `method/intent`, the selector and the counterparty resolver. */
export interface MppChallengeComposition {
  readonly normalizers: ReadonlyMap<string, ComposedMethodNormalizer>;
  readonly select: MppChallengeSelector;
  readonly resolveCounterparty: MppCounterpartyResolver;
}

export function normalizerKey(methodId: string, intent: string): string {
  return `${methodId}/${intent}`;
}

/**
 * Validates and snapshots the host's method normalizers, selector and
 * counterparty resolver, once, at `createEnterprise()`. Membership never
 * changes afterwards: no dynamic registration, and mutating the host's array
 * or objects later changes nothing. A duplicate `method/intent` is a
 * composition error, never a silent override.
 */
export function snapshotMppChallengeComposition(methods: unknown, selectChallenge: unknown, resolveCounterparty: unknown, path: string): MppChallengeComposition {
  if (!Array.isArray(methods) || methods.length === 0) throw new MppChallengeConfigurationError(`${path}.methods must be a non-empty array of trusted method normalizers.`);
  if (typeof selectChallenge !== 'function') throw new MppChallengeConfigurationError(`${path}.selectChallenge must be a synchronous function; there is no default selection and no first-wins.`);
  if (typeof resolveCounterparty !== 'function') throw new MppChallengeConfigurationError(`${path}.resolveCounterparty must be a synchronous function; a merchant string never becomes a counterparty by copying.`);
  const normalizers = new Map<string, ComposedMethodNormalizer>();
  for (const [index, candidate] of [...(methods as unknown[])].entries()) {
    if (candidate === null || typeof candidate !== 'object') throw new MppChallengeConfigurationError(`${path}.methods[${String(index)}] is not an object.`);
    const methodId = (candidate as { readonly methodId?: unknown }).methodId;
    const intent = (candidate as { readonly intent?: unknown }).intent;
    const normalize = (candidate as { readonly normalize?: unknown }).normalize;
    if (typeof methodId !== 'string' || !METHOD_ID.test(methodId)) throw new MppChallengeConfigurationError(`${path}.methods[${String(index)}].methodId is not a lowercase payment-method-id.`);
    if (intent !== 'charge') throw new MppChallengeConfigurationError(`${path}.methods[${String(index)}].intent must be 'charge'; no other intent is supported.`);
    if (typeof normalize !== 'function') throw new MppChallengeConfigurationError(`${path}.methods[${String(index)}].normalize is not a function.`);
    const key = normalizerKey(methodId, intent);
    if (normalizers.has(key)) throw new MppChallengeConfigurationError(`${path}.methods declares '${key}' more than once; every method/intent must be unique.`);
    normalizers.set(
      key,
      Object.freeze({
        methodId,
        intent: 'charge' as const,
        normalize: (challenge: ParsedMppPaymentChallenge, protectedRequest: ProtectedMppRequest) => (normalize as MppChallengeMethodNormalizer['normalize']).call(candidate, challenge, protectedRequest),
      }),
    );
  }
  return Object.freeze({ normalizers, select: selectChallenge as MppChallengeSelector, resolveCounterparty: resolveCounterparty as MppCounterpartyResolver });
}

/** Every own key read once from its descriptor, as a plain data property. An accessor, a symbol key or a non-plain object is refused unread. */
function dataProperties(raw: unknown): Map<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value);
  }
  return values;
}

const CHARGE_KEYS: ReadonlySet<string> = new Set(['amount', 'merchantReference', 'externalId']);

/**
 * A normalizer's answer, treated as external executable output: copied once
 * into fresh frozen plain data from a plain object with exactly the declared
 * keys, then held to P9 — canonical decimal text, a recognized asset, within
 * its scale, strictly positive. Anything else — a getter, a Proxy that throws,
 * a promise, a number amount, `authorized`, `ceiling`, `budget`, `grant` — is
 * not an answer.
 */
export function normalizeChargeOutput(raw: unknown, assets: MonetaryAssetRegistry): MppNormalizedCharge | undefined {
  try {
    const values = dataProperties(raw);
    if (values === undefined || [...values.keys()].some((key) => !CHARGE_KEYS.has(key))) return undefined;
    const amount = dataProperties(values.get('amount'));
    if (amount === undefined || amount.size !== 2 || !amount.has('value') || !amount.has('unit')) return undefined;
    const parsed = parseMonetaryAmount({ value: amount.get('value'), unit: amount.get('unit') }, assets);
    if (!parsed.valid || !isPositiveMonetaryAmount(parsed.amount)) return undefined;
    const merchantReference = values.get('merchantReference');
    const externalId = values.get('externalId');
    if (merchantReference !== undefined && !isCanonicalCustomerIdentifier(merchantReference)) return undefined;
    if (externalId !== undefined && !isCanonicalCustomerIdentifier(externalId)) return undefined;
    return Object.freeze({
      amount: Object.freeze({ value: parsed.amount.value, unit: parsed.amount.unit }),
      ...(merchantReference !== undefined ? { merchantReference } : {}),
      ...(externalId !== undefined ? { externalId } : {}),
    });
  } catch {
    return undefined;
  }
}

/** The trusted normalizer, asked once, fenced: its answer normalized, or `undefined`. */
export function runMethodNormalizer(normalizer: ComposedMethodNormalizer, challenge: ParsedMppPaymentChallenge, protectedRequest: ProtectedMppRequest, assets: MonetaryAssetRegistry): MppNormalizedCharge | undefined {
  let raw: unknown;
  try {
    raw = normalizer.normalize(challenge, protectedRequest);
  } catch {
    return undefined;
  }
  return normalizeChargeOutput(raw, assets);
}

/** Trusted counterparty resolution, asked once, fenced: a primitive canonical identifier, or `undefined`. */
export function resolveMppCounterparty(composition: MppChallengeComposition, context: MppCounterpartyResolutionContext): string | undefined {
  let answer: unknown;
  try {
    answer = composition.resolveCounterparty(Object.freeze({ ...context }));
  } catch {
    return undefined;
  }
  return isCanonicalCustomerIdentifier(answer) ? answer : undefined;
}

/**
 * The selector, asked once, fenced. Returns the index of the one candidate it
 * named, or `undefined` for every answer that is not exactly one candidate id —
 * including when two candidates share the named id.
 */
export function selectMppChallenge(composition: MppChallengeComposition, candidates: readonly SupportedMppChallenge[], context: MppChallengeSelectionContext): number | undefined {
  let selected: unknown;
  try {
    selected = composition.select(Object.freeze([...candidates]), Object.freeze({ ...context }));
  } catch {
    return undefined;
  }
  // A primitive string only: a promise, a boxed String or a Proxy is not an answer.
  if (typeof selected !== 'string') return undefined;
  const matches = candidates.flatMap((candidate, index) => (candidate.id === selected ? [index] : []));
  return matches.length === 1 ? matches[0] : undefined;
}
