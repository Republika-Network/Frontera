import type { MonetaryAssetRegistry } from '../../../monetary-runtime/index.js';
import {
  PaymentConfigurationError,
  isPaymentDestinationKind,
  isPaymentRailId,
  isPaymentReference,
  type PaymentContentDigest,
  type PaymentProtocolAdapter,
  type PaymentProtocolInterpretation,
  type PaymentProtocolInterpretationContext,
  type PaymentProtocolRefusal,
} from '../../domain/index.js';
import { serializeX402Json } from './x402-codec.js';
import { X402_MESSAGE_LIMITS, X402_VERSION, canonicalX402Requirements, isX402Network, isX402ResourceUrl, readX402PaymentRequiredCarrier, type X402PaymentRequirements } from './x402-messages.js';

/**
 * PAY-08 — the x402 v2 payment protocol adapter: the second implementation of
 * PAY-04's protocol-neutral `PaymentProtocolAdapter` port, beside MPP.
 *
 * ```
 * merchant 402 response (status + header fields)                     untrusted
 *   → exactly one PAYMENT-REQUIRED field, canonical base64,         x402-codec.ts, x402-messages.ts
 *     fatal UTF-8, strict JSON, closed x402 v2 PaymentRequired
 *   → resource.url = the trusted request's URL, exactly             trusted request resolution
 *   → per accepts[] entry:
 *       trusted execution mapping (scheme, network, asset)          configuration — never the merchant's word
 *       resolved paymentFlow among the mapping's flows              unknown or unsupported flows skipped
 *       maxTimeoutSeconds within the mapping's maximum              merchant timeout never overrides ours
 *       exact atomic → canonical decimal under the mapping's scale  text only, no rounding
 *       trusted network binding                                     the scheme's own client-side checks,
 *                                                                   destination and payment instrument
 *   → deterministic selection: trusted mapping priority, then a    merchant order never selects
 *     single distinct requirement — or a refusal for ambiguity
 *   → PaymentProtocolTerms + challenge evidence
 * ```
 *
 * The adapter is **pure and synchronous**: no clock (the instant is handed in),
 * no I/O, no crypto, no credential, no signer, no facilitator, no rail. It
 * builds no `PaymentPayload` — proof of payment exists only after the governed
 * payment has executed and settled (`../../../../enterprise/x402-payment-protocol`).
 * Its answer is read again, closed, by the ingress
 * (`readPaymentProtocolInterpretation`). It names no network: a network is
 * understood only by a trusted binding composed for it, and a network with no
 * mapping is not executable.
 *
 * ## The payment instrument and PAY-04's challenge identity
 *
 * An x402 `PaymentRequired` carries no server-issued challenge id. The
 * challenge identity PAY-04 records is therefore the **payment instrument** a
 * binding reports — the one object a payment for this requirement consumes
 * (for `exact` on Lightning: the invoice's payment hash, the scheme's own
 * consumption key). PAY-04's rule then applies unchanged: one instrument
 * belongs to one business operation, the same instrument with any other exact
 * term is a conflict, and the record is anchored at the CORE-07 witness. A
 * requirement for which no binding can name a merchant-unique instrument is
 * not executable here.
 */

export const X402_PROTOCOL_ID = 'x402';

/** The only scheme this adapter interprets (`specs/schemes/exact/scheme_exact.md`). */
export const X402_SUPPORTED_SCHEMES: readonly string[] = Object.freeze(['exact']);

/** The payment flows x402 v2 defines (spec §6.1). Anything else is unknown and never executed. */
export const X402_PAYMENT_FLOWS = ['authorization', 'upfront', 'escrow'] as const;
export type X402PaymentFlow = (typeof X402_PAYMENT_FLOWS)[number];

/** The flows a mapping may enable. `escrow` needs two settlements Frontera's payment model does not have, so it is never executable. */
const EXECUTABLE_FLOWS: readonly X402PaymentFlow[] = ['authorization', 'upfront'];

/**
 * x402's own words a governed request's asserted context may never carry. A
 * host registers them through the CORE-03 registry (`reservedContextKeys`)
 * beside `PAYMENT_PROTOCOL_RESERVED_CONTEXT_KEYS`.
 */
export const X402_RESERVED_CONTEXT_KEYS: readonly string[] = Object.freeze(['paymentPayload', 'paymentRequired', 'paymentRequirements', 'paymentResponse', 'paymentSignature', 'x402', 'x402Payment']);

/** The trusted description of the request the merchant answered with 402: the URL exactly as sent, and the header field values a binding may be asked to commit to. */
export interface X402TrustedRequest {
  /** The absolute request URL as the network layer sent it — never normalized. */
  readonly url: string;
  /** Lower-case header field names → the exact value sent, or `null` for a field the request did not carry. A name not listed cannot be bound. */
  readonly fields: Readonly<Record<string, string | null>>;
}

/**
 * Trusted, host-composed, synchronous: the network layer's description of the
 * protected request PAY-04's opaque `target` names. `undefined` or a throw
 * means the request cannot be bound.
 */
export type X402RequestResolver = (context: { readonly organizationId: string; readonly target: string; readonly method: string }) => X402TrustedRequest | undefined;

/** What a binding is told: one requirement, and trusted facts only. Frozen. */
export interface X402BindingRequest {
  readonly requirement: X402PaymentRequirements;
  readonly paymentFlow: X402PaymentFlow;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly bodyBearing: boolean;
    readonly contentDigest?: PaymentContentDigest;
    readonly fields: Readonly<Record<string, string | null>>;
  };
  readonly observedAtEpochMilliseconds: number;
}

/** Why a binding could not use a requirement — the port's own refusals, nothing else. */
export type X402BindingRefusal = Extract<PaymentProtocolRefusal, 'challenge-unsupported' | 'challenge-expired' | 'request-binding-mismatch' | 'normalization-failed' | 'counterparty-unresolved'>;

/** A binding's answer — read closed; anything else is `normalization-failed`. */
export type X402BindingAnswer =
  | {
      readonly usable: true;
      /** The PAY-01 destination — the binding's exact, injective translation of the requirement, never `payTo` copied. */
      readonly destination: { readonly kind: string; readonly reference: string };
      /** The merchant-unique payment instrument this payment consumes (`[a-z0-9:._-]`, at most 160 characters). */
      readonly instrument: string;
    }
  | { readonly usable: false; readonly refusal: X402BindingRefusal };

/**
 * The trusted, host-composed interpretation of one scheme on one network: the
 * scheme's client-side validity checks, its request binding, and its exact
 * translation into a PAY-01 destination. **Synchronous and pure**; anything a
 * binding must establish asynchronously (verifying a signature, say) it does
 * in `prepare`, which the paying side awaits before presenting the response to
 * the ingress, and whose result `interpret` may only read. Never a rail, a
 * signer or a facilitator.
 */
export interface X402NetworkBinding {
  readonly bindingId: string;
  /** The flows the binding's mechanism defines and it can interpret. */
  readonly paymentFlows: readonly X402PaymentFlow[];
  /** The mechanism's default flow, used when `extra.paymentFlow` is omitted. */
  readonly defaultPaymentFlow: X402PaymentFlow;
  supports(kind: { readonly scheme: string; readonly network: string; readonly asset: string }): boolean;
  prepare?(requirement: X402PaymentRequirements): Promise<void>;
  interpret(request: X402BindingRequest): X402BindingAnswer;
}

/**
 * Trusted deployment configuration: which x402 offers this deployment can
 * execute, and how. Matched **exactly** on `(scheme, network, asset)` — a
 * merchant's spelling never reaches a rail any other way. Order is priority:
 * the first mapping (in configuration order) with a usable requirement wins,
 * whatever order the merchant listed its offers in.
 */
export interface X402ExecutionMapping {
  readonly scheme: string;
  /** CAIP-2, exact. */
  readonly network: string;
  /** The x402 `asset` string, exact. */
  readonly asset: string;
  /** The P9 asset the payment is governed in. */
  readonly unit: string;
  /** Trusted scale: `amount` (atomic units) ÷ 10^`atomicScale` is the P9 value. Never read from the requirement or `extra`. */
  readonly atomicScale: number;
  readonly bindingId: string;
  /** Flows this deployment accepts for the offer — a subset of the binding's; `escrow` never. */
  readonly paymentFlows: readonly X402PaymentFlow[];
  /** A requirement asking for longer than this is not used. */
  readonly maximumTimeoutSeconds: number;
  /** PAY-01 rail preference the payment carries (bound exactly by the grant). Composition, never the merchant's. */
  readonly rail?: string;
}

export interface X402PaymentProtocolAdapterOptions {
  readonly mappings: readonly X402ExecutionMapping[];
  readonly bindings: readonly X402NetworkBinding[];
  readonly resolveRequest: X402RequestResolver;
  readonly assets: MonetaryAssetRegistry;
}

/** The adapter, plus the asynchronous preparation its bindings need before `interpret`. */
export interface X402PaymentProtocolAdapter extends PaymentProtocolAdapter {
  /** Parses the response and lets every mapped binding prepare each candidate it would interpret. Establishes nothing about authority; never throws. */
  prepare(carrier: unknown): Promise<void>;
}

const BINDING_ID = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const INSTRUMENT = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const FIELD_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const MAXIMUM_TRUSTED_FIELDS = 32;
const MAXIMUM_MAPPINGS = 16;

interface ComposedMapping extends X402ExecutionMapping {
  readonly priority: number;
  readonly binding: ComposedBinding;
}

interface ComposedBinding {
  readonly bindingId: string;
  readonly paymentFlows: readonly X402PaymentFlow[];
  readonly defaultPaymentFlow: X402PaymentFlow;
  readonly prepare?: (requirement: X402PaymentRequirements) => Promise<void>;
  readonly interpret: (request: X402BindingRequest) => unknown;
}

const isFlow = (value: unknown): value is X402PaymentFlow => typeof value === 'string' && (X402_PAYMENT_FLOWS as readonly string[]).includes(value);

function snapshotBindings(raw: unknown): ReadonlyMap<string, ComposedBinding & { readonly supports: (kind: { readonly scheme: string; readonly network: string; readonly asset: string }) => boolean }> {
  if (!Array.isArray(raw) || raw.length === 0) throw new PaymentConfigurationError('x402 bindings must be a non-empty array.');
  const out = new Map<string, ComposedBinding & { readonly supports: (kind: { readonly scheme: string; readonly network: string; readonly asset: string }) => boolean }>();
  for (const candidate of raw as unknown[]) {
    if (candidate === null || typeof candidate !== 'object') throw new PaymentConfigurationError('An x402 binding must be an object.');
    const binding = candidate as Partial<X402NetworkBinding>;
    const { bindingId, paymentFlows, defaultPaymentFlow, supports, prepare, interpret } = binding;
    if (typeof bindingId !== 'string' || !BINDING_ID.test(bindingId)) throw new PaymentConfigurationError('An x402 binding id is malformed.');
    if (out.has(bindingId)) throw new PaymentConfigurationError(`x402 binding '${bindingId}' is declared more than once.`);
    if (!Array.isArray(paymentFlows) || paymentFlows.length === 0 || !paymentFlows.every((flow) => EXECUTABLE_FLOWS.includes(flow))) throw new PaymentConfigurationError(`x402 binding '${bindingId}' declares flows Frontera cannot execute.`);
    if (!isFlow(defaultPaymentFlow)) throw new PaymentConfigurationError(`x402 binding '${bindingId}' has no default flow.`);
    if (typeof supports !== 'function' || typeof interpret !== 'function' || (prepare !== undefined && typeof prepare !== 'function')) throw new PaymentConfigurationError(`x402 binding '${bindingId}' is incomplete.`);
    out.set(
      bindingId,
      Object.freeze({
        bindingId,
        paymentFlows: Object.freeze([...paymentFlows]),
        defaultPaymentFlow,
        supports: (kind: { readonly scheme: string; readonly network: string; readonly asset: string }) => supports.call(candidate, kind) === true,
        ...(prepare !== undefined ? { prepare: (requirement: X402PaymentRequirements) => prepare.call(candidate, requirement) } : {}),
        interpret: (request: X402BindingRequest) => interpret.call(candidate, request) as unknown,
      }),
    );
  }
  return out;
}

function snapshotMappings(raw: unknown, bindings: ReturnType<typeof snapshotBindings>, assets: MonetaryAssetRegistry): readonly ComposedMapping[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAXIMUM_MAPPINGS) throw new PaymentConfigurationError('x402 mappings must be a non-empty array of at most 16 entries.');
  const seen = new Set<string>();
  return Object.freeze(
    (raw as unknown[]).map((candidate, priority) => {
      if (candidate === null || typeof candidate !== 'object') throw new PaymentConfigurationError('An x402 mapping must be an object.');
      const mapping = candidate as Partial<X402ExecutionMapping>;
      const { scheme, network, asset, unit, atomicScale, bindingId, paymentFlows, maximumTimeoutSeconds, rail } = mapping;
      if (typeof scheme !== 'string' || !X402_SUPPORTED_SCHEMES.includes(scheme)) throw new PaymentConfigurationError('An x402 mapping names a scheme this adapter does not interpret.');
      if (!isX402Network(network)) throw new PaymentConfigurationError('An x402 mapping network is not CAIP-2.');
      if (typeof asset !== 'string' || asset.length === 0 || asset.length > X402_MESSAGE_LIMITS.maxAssetLength || !/^[!-~]+$/.test(asset)) throw new PaymentConfigurationError('An x402 mapping asset is malformed.');
      const definition = assets.resolve(unit);
      if (definition === undefined) throw new PaymentConfigurationError('An x402 mapping unit is not in the P9 registry.');
      if (typeof atomicScale !== 'number' || !Number.isSafeInteger(atomicScale) || atomicScale < 0 || atomicScale > definition.scale) throw new PaymentConfigurationError('An x402 mapping scale exceeds its P9 asset scale.');
      const binding = typeof bindingId === 'string' ? bindings.get(bindingId) : undefined;
      if (binding === undefined) throw new PaymentConfigurationError('An x402 mapping names no composed binding.');
      if (!binding.supports({ scheme, network, asset })) throw new PaymentConfigurationError(`x402 binding '${binding.bindingId}' does not support ${scheme} / ${network} / ${asset}.`);
      if (!Array.isArray(paymentFlows) || paymentFlows.length === 0 || !paymentFlows.every((flow) => binding.paymentFlows.includes(flow))) throw new PaymentConfigurationError('An x402 mapping enables a flow its binding cannot interpret.');
      if (typeof maximumTimeoutSeconds !== 'number' || !Number.isSafeInteger(maximumTimeoutSeconds) || maximumTimeoutSeconds <= 0 || maximumTimeoutSeconds > X402_MESSAGE_LIMITS.maxTimeoutSeconds) throw new PaymentConfigurationError('An x402 mapping timeout maximum is malformed.');
      if (rail !== undefined && !isPaymentRailId(rail)) throw new PaymentConfigurationError('An x402 mapping rail is not a PAY-01 rail id.');
      const key = JSON.stringify([scheme, network, asset]);
      if (seen.has(key)) throw new PaymentConfigurationError('An x402 offer (scheme, network, asset) is mapped more than once.');
      seen.add(key);
      return Object.freeze({
        scheme,
        network,
        asset,
        unit: definition.assetId,
        atomicScale,
        bindingId: binding.bindingId,
        paymentFlows: Object.freeze([...paymentFlows]),
        maximumTimeoutSeconds,
        ...(rail !== undefined ? { rail } : {}),
        priority,
        binding,
      });
    }),
  );
}

/** Exact atomic units → the canonical decimal under a trusted scale. Text only: no number, no rounding. */
export function x402DecimalOfAtomic(atomic: string, scale: number): string {
  if (scale === 0) return atomic;
  const padded = atomic.padStart(scale + 1, '0');
  const integer = padded.slice(0, padded.length - scale).replace(/^0+(?=[0-9])/, '');
  const fraction = padded.slice(padded.length - scale).replace(/0+$/, '');
  return fraction.length === 0 ? integer : `${integer}.${fraction}`;
}

/** The trusted request description, read closed from its own data. */
function readTrustedRequest(raw: unknown): X402TrustedRequest | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 2 || !keys.includes('url') || !keys.includes('fields')) return undefined;
    const url = (Object.getOwnPropertyDescriptor(raw, 'url') as PropertyDescriptor).value as unknown;
    const rawFields = (Object.getOwnPropertyDescriptor(raw, 'fields') as PropertyDescriptor).value as unknown;
    if (!isX402ResourceUrl(url) || rawFields === null || typeof rawFields !== 'object' || Array.isArray(rawFields)) return undefined;
    const prototype = Object.getPrototypeOf(rawFields) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const fieldKeys = Reflect.ownKeys(rawFields);
    if (fieldKeys.length > MAXIMUM_TRUSTED_FIELDS) return undefined;
    const fields = Object.create(null) as Record<string, string | null>;
    for (const key of fieldKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(rawFields, key);
      if (typeof key !== 'string' || !FIELD_NAME.test(key) || descriptor === undefined || !('value' in descriptor)) return undefined;
      const value = descriptor.value as unknown;
      if (value !== null && (typeof value !== 'string' || value.length > 8_192)) return undefined;
      fields[key] = value as string | null;
    }
    return Object.freeze({ url, fields: Object.freeze(fields) });
  } catch {
    return undefined;
  }
}

/** A binding's answer, read closed from its own data. */
function readBindingAnswer(raw: unknown): X402BindingAnswer | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const prototype = Object.getPrototypeOf(raw) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const values = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor)) return undefined;
      values.set(key, descriptor.value as unknown);
    }
    const usable = values.get('usable');
    if (usable === false) {
      const refusal = values.get('refusal');
      const allowed: readonly string[] = ['challenge-unsupported', 'challenge-expired', 'request-binding-mismatch', 'normalization-failed', 'counterparty-unresolved'];
      if (values.size !== 2 || typeof refusal !== 'string' || !allowed.includes(refusal)) return undefined;
      return Object.freeze({ usable: false, refusal: refusal as X402BindingRefusal });
    }
    if (usable !== true || values.size !== 3) return undefined;
    const instrument = values.get('instrument');
    const destination = values.get('destination');
    if (typeof instrument !== 'string' || !INSTRUMENT.test(instrument) || destination === null || typeof destination !== 'object' || Array.isArray(destination)) return undefined;
    const destinationKeys = Reflect.ownKeys(destination);
    if (destinationKeys.length !== 2) return undefined;
    const kind = Object.getOwnPropertyDescriptor(destination, 'kind')?.value as unknown;
    const reference = Object.getOwnPropertyDescriptor(destination, 'reference')?.value as unknown;
    if (!isPaymentDestinationKind(kind) || !isPaymentReference(reference)) return undefined;
    return Object.freeze({ usable: true, destination: Object.freeze({ kind, reference }), instrument });
  } catch {
    return undefined;
  }
}

interface Candidate {
  readonly priority: number;
  readonly canonical: string;
  readonly requirement: X402PaymentRequirements;
  readonly mapping: ComposedMapping;
  readonly paymentFlow: X402PaymentFlow;
  readonly destination: { readonly kind: string; readonly reference: string };
  readonly instrument: string;
}

/** Refusal precedence when nothing is usable — fixed, so the merchant's order cannot choose it. */
const PRECEDENCE: readonly X402BindingRefusal[] = ['request-binding-mismatch', 'challenge-expired', 'normalization-failed', 'counterparty-unresolved', 'challenge-unsupported'];

export function createX402PaymentProtocolAdapter(options: X402PaymentProtocolAdapterOptions): X402PaymentProtocolAdapter {
  const assets = options?.assets;
  if (assets === null || typeof assets !== 'object' || typeof assets.resolve !== 'function') throw new PaymentConfigurationError('The x402 adapter needs the P9 asset registry.');
  const resolveRequest = options.resolveRequest;
  if (typeof resolveRequest !== 'function') throw new PaymentConfigurationError('The x402 adapter needs a trusted request resolver.');
  const bindings = snapshotBindings(options.bindings);
  const mappings = snapshotMappings(options.mappings, bindings, assets);

  const mappingOf = (requirement: X402PaymentRequirements): ComposedMapping | undefined =>
    mappings.find((mapping) => mapping.scheme === requirement.scheme && mapping.network === requirement.network && mapping.asset === requirement.asset);

  /** The flow the requirement resolves to under its mapping's binding, or `undefined` when it is unknown, missing or not enabled. */
  const flowOf = (requirement: X402PaymentRequirements, mapping: ComposedMapping): X402PaymentFlow | undefined => {
    const stated = requirement.extra !== undefined && Object.prototype.hasOwnProperty.call(requirement.extra, 'paymentFlow') ? requirement.extra['paymentFlow'] : undefined;
    const flow = stated ?? mapping.binding.defaultPaymentFlow;
    // An unrecognized flow is never constructed (spec §6.1); a recognized one this deployment did not enable is skipped too.
    return isFlow(flow) && mapping.paymentFlows.includes(flow) ? flow : undefined;
  };

  const interpret = (challenges: unknown, context: PaymentProtocolInterpretationContext): PaymentProtocolInterpretation => {
    try {
      const parsed = readX402PaymentRequiredCarrier(challenges);
      if (!parsed.valid) return { interpreted: false, refusal: 'challenge-invalid' };
      const { protectedRequest } = context;
      let trusted: X402TrustedRequest | undefined;
      try {
        trusted = readTrustedRequest(resolveRequest(Object.freeze({ organizationId: context.organizationId, target: protectedRequest.target, method: protectedRequest.method })));
      } catch {
        trusted = undefined;
      }
      // The merchant's resource must be exactly the request the network layer sent: no normalization, no equivalence.
      if (trusted === undefined || trusted.url !== parsed.value.resource.url) return { interpreted: false, refusal: 'request-binding-mismatch' };

      const usable: Candidate[] = [];
      const refusals = new Set<X402BindingRefusal>();
      for (const requirement of parsed.value.accepts) {
        const mapping = mappingOf(requirement);
        if (mapping === undefined) {
          refusals.add('challenge-unsupported');
          continue;
        }
        const paymentFlow = flowOf(requirement, mapping);
        if (paymentFlow === undefined || requirement.maxTimeoutSeconds > mapping.maximumTimeoutSeconds) {
          refusals.add('challenge-unsupported');
          continue;
        }
        const request: X402BindingRequest = Object.freeze({
          requirement,
          paymentFlow,
          request: Object.freeze({
            url: trusted.url,
            method: protectedRequest.method,
            bodyBearing: protectedRequest.bodyBearing,
            ...(protectedRequest.contentDigest !== undefined ? { contentDigest: protectedRequest.contentDigest } : {}),
            fields: trusted.fields,
          }),
          observedAtEpochMilliseconds: context.observedAtEpochMilliseconds,
        });
        let answer: X402BindingAnswer | undefined;
        try {
          answer = readBindingAnswer(mapping.binding.interpret(request));
        } catch {
          answer = undefined;
        }
        if (answer === undefined) {
          refusals.add('normalization-failed');
          continue;
        }
        if (!answer.usable) {
          refusals.add(answer.refusal);
          continue;
        }
        usable.push({ priority: mapping.priority, canonical: canonicalX402Requirements(requirement), requirement, mapping, paymentFlow, destination: answer.destination, instrument: answer.instrument });
      }

      if (usable.length === 0) return { interpreted: false, refusal: PRECEDENCE.find((refusal) => refusals.has(refusal)) ?? 'challenge-unsupported' };
      // Trusted priority, never merchant order: the first mapping with a usable offer. Within it, identical offers
      // (however spelled) are one; two different ones are ambiguous and refused, never first-wins.
      const best = Math.min(...usable.map((candidate) => candidate.priority));
      const distinct = new Map<string, Candidate>();
      for (const candidate of usable) if (candidate.priority === best) distinct.set(candidate.canonical, candidate);
      if (distinct.size !== 1) return { interpreted: false, refusal: 'challenge-ambiguous' };
      const chosen = [...distinct.values()][0] as Candidate;
      // The same instrument offered under two different terms anywhere in the response is a contradiction, not a choice.
      if (usable.some((candidate) => candidate.instrument === chosen.instrument && candidate.canonical !== chosen.canonical)) return { interpreted: false, refusal: 'challenge-ambiguous' };

      const fields: Record<string, string> = {
        version: String(X402_VERSION),
        scheme: chosen.requirement.scheme,
        network: chosen.requirement.network,
        asset: chosen.requirement.asset,
        'pay-to': chosen.requirement.payTo,
        amount: chosen.requirement.amount,
        'max-timeout': String(chosen.requirement.maxTimeoutSeconds),
        'payment-flow': chosen.paymentFlow,
        binding: chosen.mapping.bindingId,
        instrument: chosen.instrument,
        requirement: chosen.canonical,
      };
      if (parsed.value.extensions !== undefined) {
        const extensions = serializeX402Json(parsed.value.extensions);
        if (extensions === undefined) return { interpreted: false, refusal: 'challenge-invalid' };
        fields['extensions'] = extensions;
      }
      return {
        interpreted: true,
        terms: {
          destination: chosen.destination,
          amount: { value: x402DecimalOfAtomic(chosen.requirement.amount, chosen.mapping.atomicScale), unit: chosen.mapping.unit },
          ...(chosen.mapping.rail !== undefined ? { rail: chosen.mapping.rail } : {}),
        },
        challenge: { key: `${X402_PROTOCOL_ID}:${String(X402_VERSION)}:${chosen.instrument}`, fields },
      };
    } catch {
      return { interpreted: false, refusal: 'challenge-invalid' };
    }
  };

  return Object.freeze({
    protocolId: X402_PROTOCOL_ID,
    reservedContextKeys: X402_RESERVED_CONTEXT_KEYS,
    interpret,
    async prepare(carrier: unknown): Promise<void> {
      const parsed = readX402PaymentRequiredCarrier(carrier);
      if (!parsed.valid) return;
      for (const requirement of parsed.value.accepts) {
        const mapping = mappingOf(requirement);
        if (mapping?.binding.prepare === undefined || flowOf(requirement, mapping) === undefined) continue;
        try {
          await mapping.binding.prepare(requirement);
        } catch {
          // A binding that could not prepare a candidate refuses it at interpretation.
        }
      }
    },
  });
}
