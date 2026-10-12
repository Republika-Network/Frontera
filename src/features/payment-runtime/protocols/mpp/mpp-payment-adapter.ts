import { isPositiveMonetaryAmount, parseMonetaryAmount, type MonetaryAmount, type MonetaryAssetRegistry } from '../../../monetary-runtime/index.js';
import {
  PaymentConfigurationError,
  isPaymentBusinessReference,
  isPaymentDestinationKind,
  isPaymentRailId,
  isPaymentReference,
  paymentContentDigestsAgree,
  parsePaymentContentDigest,
  type PaymentDestination,
  type PaymentProtectedRequestBinding,
  type PaymentProtocolAdapter,
  type PaymentProtocolInterpretation,
  type PaymentProtocolInterpretationContext,
  type PaymentProtocolRefusal,
} from '../../domain/index.js';
import { isMppChallengeUsableAt, mppChallengeFieldsOf, mppChallengeKeyOf, parseMppPaymentChallenge, type MppPaymentChallenge } from './mpp-challenge.js';
import { parseWwwAuthenticate } from './mpp-grammar.js';

/**
 * PAY-04 — the MPP payment protocol adapter: the first implementation of the
 * protocol-neutral `PaymentProtocolAdapter` port.
 *
 * ```
 * WWW-Authenticate field value(s) of the merchant's 402    untrusted
 *   → RFC 9110 tokenizer, Payment challenges validated     mpp-grammar.ts, mpp-challenge.ts
 *   → per challenge with a composed method normalizer:
 *       protection space (realm) and body-digest binding  against the trusted protected request
 *       expiry                                             against the trusted clock instant
 *       trusted method normalizer                          exact P9 amount (+ business reference)
 *       trusted counterparty resolver                      a PAY-01 destination — never a merchant string copied
 *   → trusted selector                                     exactly one, asked even for one; never first-wins
 *   → PaymentProtocolTerms + challenge evidence
 * ```
 *
 * The adapter is **pure and synchronous**: it reads no clock (the instant is
 * handed to it), performs no I/O, holds no credential, constructs no MPP
 * credential, calls no rail and decides nothing about authority. Its answer
 * is read again, closed, by the ingress (`readPaymentProtocolInterpretation`).
 * Nothing here names a rail: which rail executes the payment is trusted
 * routing's call, and a method normalizer may at most declare a PAY-01 rail
 * *preference* as composition.
 */

export const MPP_PROTOCOL_ID = 'mpp';

/** The only MPP intent this adapter interprets (`draft-payment-intent-charge-00`). */
export const MPP_CHARGE_INTENT = 'charge';

/**
 * MPP's own words a governed request's asserted context may never carry. A
 * host registers them through the CORE-03 registry (`reservedContextKeys`)
 * beside `PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS`; the core's built-in list is
 * never extended with them.
 */
export const MPP_RESERVED_CONTEXT_KEYS: readonly string[] = Object.freeze(['mppChallenge', 'mppChallengeId', 'mppIntent', 'mppMethod', 'mppRealm']);

/**
 * What a trusted method normalizer reports about one `charge` challenge:
 * payment terms and nothing else. Read once from own data properties into
 * fresh data and refused whole on any other key — there is no field for
 * authorization, a ceiling, a budget, a grant, a destination, a source, an
 * outcome, a credential or a signature.
 */
export interface MppChargeNormalization {
  /** Exact P9 money: canonical decimal text and a registry asset — the normalizer's trusted mapping of the method's base units and currency, never a guess. */
  readonly amount: { readonly value: string; readonly unit: string };
  /** The method's merchant / payment target, normalized. Input to trusted counterparty resolution only — never itself a destination. */
  readonly merchantReference?: string;
  /** A merchant order identity the method defines, as a PAY-01 business reference. Bound exactly by the grant; part of the business operation's terms. */
  readonly reference?: string;
}

/**
 * A trusted, host-composed interpreter of one payment method's `charge`
 * request. Composed once; `methodId`, `intent`, `rail` and `normalize` are
 * snapshotted and never re-read. **Synchronous**: a promise is not an answer.
 * `undefined` or a throw means this challenge cannot be interpreted.
 *
 * It sees the decoded challenge and the trusted protected request; it never
 * sees a credential, and it cannot choose the business operation, the
 * idempotency key, the source account, the purpose or the destination.
 */
export interface MppMethodNormalizer {
  readonly methodId: string;
  readonly intent: typeof MPP_CHARGE_INTENT;
  /** Trusted composition: the PAY-01 rail preference payments of this method carry. Never read from the challenge. */
  readonly rail?: string;
  normalize(challenge: MppPaymentChallenge, protectedRequest: PaymentProtectedRequestBinding): MppChargeNormalization | undefined;
}

/** What trusted counterparty resolution is told. The realm is the merchant's protection space: context, never authority. */
export interface MppCounterpartyResolutionContext {
  readonly organizationId: string;
  readonly methodId: string;
  readonly intent: typeof MPP_CHARGE_INTENT;
  readonly realm: string;
  readonly merchantReference?: string;
  readonly target: string;
  readonly method: string;
}

/**
 * Trusted, host-side, **synchronous** mapping to the PAY-01 destination the
 * payment names. `undefined` (or a throw, a promise, anything outside PAY-01's
 * destination grammar) refuses the challenge: a merchant string never becomes
 * a destination by copying.
 */
export type MppCounterpartyResolver = (context: MppCounterpartyResolutionContext) => PaymentDestination | undefined;

/** One usable challenge, as the selector sees it: fresh, frozen, normalized. */
export interface MppChallengeCandidate {
  readonly id: string;
  readonly realm: string;
  readonly method: string;
  readonly intent: typeof MPP_CHARGE_INTENT;
  readonly expires?: string;
  readonly amount: MonetaryAmount;
  readonly destination: PaymentDestination;
  readonly reference?: string;
  readonly rail?: string;
}

export interface MppChallengeSelectionContext {
  readonly organizationId: string;
  readonly businessOperationId: string;
  readonly target: string;
  readonly method: string;
}

/**
 * Trusted, host-side, **synchronous** choice among usable challenges. Asked
 * even when only one remains; must return the `id` of exactly one candidate.
 * A throw, a promise, an unknown id, or an id two candidates share refuses:
 * there is no "first challenge wins", so the merchant's ordering never selects.
 */
export type MppChallengeSelector = (candidates: readonly MppChallengeCandidate[], context: MppChallengeSelectionContext) => string | undefined;

export interface MppPaymentProtocolAdapterOptions {
  readonly methods: readonly MppMethodNormalizer[];
  readonly resolveCounterparty: MppCounterpartyResolver;
  readonly selectChallenge: MppChallengeSelector;
  /** The same P9 registry the governed path holds. */
  readonly assets: MonetaryAssetRegistry;
}

/** The draft's `payment-method-id = 1*LOWERALPHA`. */
const METHOD_ID = /^[a-z]{1,64}$/;

interface ComposedNormalizer {
  readonly methodId: string;
  readonly rail?: string;
  readonly normalize: (challenge: MppPaymentChallenge, protectedRequest: PaymentProtectedRequestBinding) => unknown;
}

/** One own property, read once from its descriptor; an accessor is refused without being run. */
function dataOf(source: object, key: string): { readonly value: unknown } | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor === undefined ? { value: undefined } : 'value' in descriptor ? { value: descriptor.value as unknown } : undefined;
}

/**
 * Validates and snapshots the host's method normalizers once. Membership
 * never changes afterwards: no dynamic registration, and mutating the host's
 * array or objects later changes nothing. A duplicate `method/intent` is a
 * composition error, never a silent override.
 */
function snapshotNormalizers(methods: unknown): ReadonlyMap<string, ComposedNormalizer> {
  if (!Array.isArray(methods) || methods.length === 0) throw new PaymentConfigurationError('MPP: methods must be a non-empty array of trusted method normalizers.');
  const normalizers = new Map<string, ComposedNormalizer>();
  for (const [index, candidate] of [...(methods as unknown[])].entries()) {
    if (candidate === null || typeof candidate !== 'object') throw new PaymentConfigurationError(`MPP: methods[${String(index)}] is not an object.`);
    const methodId = dataOf(candidate, 'methodId')?.value;
    const intent = dataOf(candidate, 'intent')?.value;
    const rail = dataOf(candidate, 'rail');
    const normalize = (candidate as { readonly normalize?: unknown }).normalize;
    if (typeof methodId !== 'string' || !METHOD_ID.test(methodId)) throw new PaymentConfigurationError(`MPP: methods[${String(index)}].methodId is not a lowercase payment-method-id.`);
    if (intent !== MPP_CHARGE_INTENT) throw new PaymentConfigurationError(`MPP: methods[${String(index)}].intent must be '${MPP_CHARGE_INTENT}'; no other intent is supported.`);
    if (rail === undefined || (rail.value !== undefined && !isPaymentRailId(rail.value))) throw new PaymentConfigurationError(`MPP: methods[${String(index)}].rail must be a PAY-01 rail id when stated.`);
    if (typeof normalize !== 'function') throw new PaymentConfigurationError(`MPP: methods[${String(index)}].normalize is not a function.`);
    if (normalizers.has(methodId)) throw new PaymentConfigurationError(`MPP: methods declares '${methodId}/${MPP_CHARGE_INTENT}' more than once.`);
    normalizers.set(
      methodId,
      Object.freeze({
        methodId,
        ...(rail.value !== undefined ? { rail: rail.value as string } : {}),
        normalize: (challenge: MppPaymentChallenge, protectedRequest: PaymentProtectedRequestBinding): unknown => (normalize as MppMethodNormalizer['normalize']).call(candidate, challenge, protectedRequest),
      }),
    );
  }
  return normalizers;
}

/** Own data properties of a plain object, each read once; anything else `undefined`. */
function plainData(raw: unknown, allowed: readonly string[]): Map<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const prototype = Object.getPrototypeOf(raw) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const values = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(raw)) {
    if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (descriptor === undefined || !('value' in descriptor)) return undefined;
    values.set(key, descriptor.value as unknown);
  }
  return values;
}

const CHARGE_KEYS: readonly string[] = ['amount', 'merchantReference', 'reference'];
const AMOUNT_KEYS: readonly string[] = ['value', 'unit'];
const DESTINATION_KEYS: readonly string[] = ['kind', 'reference'];

interface NormalizedCharge {
  readonly amount: MonetaryAmount;
  readonly merchantReference?: string;
  readonly reference?: string;
}

/**
 * A normalizer's answer, treated as external executable output: copied once
 * from a plain object with exactly the declared keys, then held to P9 —
 * canonical decimal text, a recognized asset, within its scale, strictly
 * positive. A getter, a Proxy that throws, a promise, a number amount, or any
 * other key is not an answer.
 */
function readCharge(raw: unknown, assets: MonetaryAssetRegistry): NormalizedCharge | undefined {
  try {
    const values = plainData(raw, CHARGE_KEYS);
    if (values === undefined) return undefined;
    const amount = plainData(values.get('amount'), AMOUNT_KEYS);
    if (amount === undefined || amount.size !== 2) return undefined;
    const parsed = parseMonetaryAmount({ value: amount.get('value'), unit: amount.get('unit') }, assets);
    if (!parsed.valid || !isPositiveMonetaryAmount(parsed.amount)) return undefined;
    const merchantReference = values.get('merchantReference');
    const reference = values.get('reference');
    if (merchantReference !== undefined && !isPaymentReference(merchantReference)) return undefined;
    if (reference !== undefined && !isPaymentBusinessReference(reference)) return undefined;
    return Object.freeze({
      amount: parsed.amount,
      ...(merchantReference !== undefined ? { merchantReference: merchantReference as string } : {}),
      ...(reference !== undefined ? { reference: reference as string } : {}),
    });
  } catch {
    return undefined;
  }
}

/** A resolver's answer: exactly a PAY-01 destination, read once. */
function readDestination(raw: unknown): PaymentDestination | undefined {
  try {
    const values = plainData(raw, DESTINATION_KEYS);
    if (values === undefined || values.size !== 2) return undefined;
    const kind = values.get('kind');
    const reference = values.get('reference');
    if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) return undefined;
    return Object.freeze({ kind, reference });
  } catch {
    return undefined;
  }
}

interface UsableChallenge {
  readonly challenge: MppPaymentChallenge;
  readonly charge: NormalizedCharge;
  readonly destination: PaymentDestination;
  readonly rail?: string;
}

/**
 * When no challenge is usable, the reason reported — by a fixed precedence,
 * never by the merchant's ordering: a binding failure first (the most
 * security-relevant), then expiry, then interpretation, then resolution.
 */
const FAILURE_PRECEDENCE: readonly PaymentProtocolRefusal[] = ['request-binding-mismatch', 'challenge-expired', 'normalization-failed', 'counterparty-unresolved'];

/** Whether a challenge binds the trusted protected request: its protection space, and — exactly when the request has a body — that body's digest. */
function bindsProtectedRequest(challenge: MppPaymentChallenge, protectedRequest: PaymentProtectedRequestBinding): boolean {
  if (protectedRequest.expectedRealm !== undefined && challenge.realm !== protectedRequest.expectedRealm) return false;
  if (protectedRequest.bodyBearing) {
    const challengeDigest = challenge.digest === undefined ? undefined : parsePaymentContentDigest(challenge.digest);
    return challengeDigest !== undefined && protectedRequest.contentDigest !== undefined && paymentContentDigestsAgree(challengeDigest, protectedRequest.contentDigest);
  }
  // A digest over a body this request does not carry binds nothing.
  return challenge.digest === undefined;
}

/**
 * Composes the MPP adapter from trusted configuration, once. Throws
 * `PaymentConfigurationError` at composition; never while interpreting.
 */
export function createMppPaymentProtocolAdapter(options: MppPaymentProtocolAdapterOptions): PaymentProtocolAdapter {
  const normalizers = snapshotNormalizers(options?.methods);
  const resolveCounterparty: unknown = options.resolveCounterparty;
  const selectChallenge: unknown = options.selectChallenge;
  const assets: unknown = options.assets;
  if (typeof resolveCounterparty !== 'function') throw new PaymentConfigurationError('MPP: resolveCounterparty must be a synchronous function; a merchant string never becomes a destination by copying.');
  if (typeof selectChallenge !== 'function') throw new PaymentConfigurationError('MPP: selectChallenge must be a synchronous function; there is no default selection and no first-wins.');
  if (assets === null || typeof assets !== 'object' || typeof (assets as { readonly resolve?: unknown }).resolve !== 'function') throw new PaymentConfigurationError('MPP: a P9 asset registry is required.');
  const resolve = resolveCounterparty as MppCounterpartyResolver;
  const select = selectChallenge as MppChallengeSelector;
  const registry = assets as MonetaryAssetRegistry;

  const refused = (refusal: PaymentProtocolRefusal): PaymentProtocolInterpretation => Object.freeze({ interpreted: false, refusal });

  function interpret(challenges: unknown, context: PaymentProtocolInterpretationContext): PaymentProtocolInterpretation {
    const { protectedRequest, observedAtEpochMilliseconds: instant } = context;
    const parsed = parseWwwAuthenticate(challenges);
    if (!parsed.valid) return refused('challenge-invalid');
    const wellFormed: MppPaymentChallenge[] = [];
    for (const raw of parsed.challenges) {
      if (raw.scheme.toLowerCase() !== 'payment') continue;
      const challenge = parseMppPaymentChallenge(raw);
      // A malformed Payment challenge is never usable; it does not make the others unusable.
      if (challenge.valid) wellFormed.push(challenge.challenge);
    }
    if (wellFormed.length === 0) return refused('challenge-invalid');

    // Only challenges a trusted normalizer composes for their exact method and intent.
    const supported = wellFormed.filter((challenge) => challenge.intent === MPP_CHARGE_INTENT && normalizers.has(challenge.method));
    if (supported.length === 0) return refused('challenge-unsupported');

    const usable: UsableChallenge[] = [];
    const failures = new Set<PaymentProtocolRefusal>();
    for (const challenge of supported) {
      if (!bindsProtectedRequest(challenge, protectedRequest)) {
        failures.add('request-binding-mismatch');
        continue;
      }
      if (!isMppChallengeUsableAt(challenge, instant)) {
        failures.add('challenge-expired');
        continue;
      }
      const normalizer = normalizers.get(challenge.method);
      let rawCharge: unknown;
      try {
        rawCharge = normalizer?.normalize(challenge, protectedRequest);
      } catch {
        rawCharge = undefined;
      }
      const charge = readCharge(rawCharge, registry);
      if (normalizer === undefined || charge === undefined) {
        failures.add('normalization-failed');
        continue;
      }
      let rawDestination: unknown;
      try {
        rawDestination = resolve(
          Object.freeze({
            organizationId: context.organizationId,
            methodId: challenge.method,
            intent: MPP_CHARGE_INTENT,
            realm: challenge.realm,
            ...(charge.merchantReference !== undefined ? { merchantReference: charge.merchantReference } : {}),
            target: protectedRequest.target,
            method: protectedRequest.method,
          }),
        );
      } catch {
        rawDestination = undefined;
      }
      const destination = readDestination(rawDestination);
      if (destination === undefined) {
        failures.add('counterparty-unresolved');
        continue;
      }
      usable.push({ challenge, charge, destination, ...(normalizer.rail !== undefined ? { rail: normalizer.rail } : {}) });
    }
    if (usable.length === 0) return refused(FAILURE_PRECEDENCE.find((failure) => failures.has(failure)) ?? 'challenge-invalid');

    // Trusted selection — asked even for one candidate; no first-wins.
    const candidates: readonly MppChallengeCandidate[] = Object.freeze(
      usable.map(({ challenge, charge, destination, rail }) =>
        Object.freeze({
          id: challenge.id,
          realm: challenge.realm,
          method: challenge.method,
          intent: MPP_CHARGE_INTENT,
          ...(challenge.expires !== undefined ? { expires: challenge.expires } : {}),
          amount: charge.amount,
          destination,
          ...(charge.reference !== undefined ? { reference: charge.reference } : {}),
          ...(rail !== undefined ? { rail } : {}),
        }),
      ),
    );
    let chosen: unknown;
    try {
      chosen = select(candidates, Object.freeze({ organizationId: context.organizationId, businessOperationId: context.businessOperationId, target: protectedRequest.target, method: protectedRequest.method }));
    } catch {
      chosen = undefined;
    }
    // A primitive string only: a promise, a boxed String or a Proxy is not an answer.
    if (typeof chosen !== 'string') return refused('challenge-ambiguous');
    const matches = usable.filter(({ challenge }) => challenge.id === chosen);
    const selected = matches.length === 1 ? matches[0] : undefined;
    if (selected === undefined) return refused('challenge-ambiguous');

    return Object.freeze({
      interpreted: true,
      terms: Object.freeze({
        destination: selected.destination,
        amount: selected.charge.amount,
        ...(selected.charge.reference !== undefined ? { reference: selected.charge.reference } : {}),
        ...(selected.rail !== undefined ? { rail: selected.rail } : {}),
      }),
      challenge: Object.freeze({ key: mppChallengeKeyOf(selected.challenge), fields: mppChallengeFieldsOf(selected.challenge) }),
    });
  }

  return Object.freeze({
    protocolId: MPP_PROTOCOL_ID,
    reservedContextKeys: MPP_RESERVED_CONTEXT_KEYS,
    interpret(challenges: unknown, context: PaymentProtocolInterpretationContext): PaymentProtocolInterpretation {
      // Total: malformed input is a closed refusal, never a crash of the Host.
      try {
        return interpret(challenges, context);
      } catch {
        return refused('challenge-invalid');
      }
    },
  });
}
