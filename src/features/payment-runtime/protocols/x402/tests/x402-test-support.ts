import { createMonetaryAssetRegistry } from '../../../../monetary-runtime/index.js';
import { readPaymentProtectedRequest, type PaymentProtocolInterpretationContext } from '../../../domain/index.js';
import { createX402PaymentProtocolAdapter, type X402BindingAnswer, type X402BindingRequest, type X402ExecutionMapping, type X402NetworkBinding, type X402PaymentProtocolAdapter } from '../index.js';

/**
 * PAY-08 test support for the pure x402 adapter: merchant messages built as
 * plain JSON and base64-encoded the way a resource server does, and a
 * crypto-free network binding over two fictitious networks. The real
 * binding (`exact` on Lightning) is tested at its edge, with real invoices.
 */

export const RESOURCE_URL = 'https://api.merchant.example/reports/42?format=json&lang=en';
export const TARGET = 'merchant:report-42';
export const NET_A = 'test:net-a';
export const NET_B = 'test:net-b';
export const TOKEN = 'TOK';
export const UNIT_A = 'test:TOK';
export const UNIT_B = 'test:TOKB';

export const ASSETS = createMonetaryAssetRegistry([
  { assetId: UNIT_A, scale: 6 },
  { assetId: UNIT_B, scale: 2 },
]);

/** What the fake binding's trusted directory maps a `payTo` to — a merchant string never becomes a destination by itself. */
export const DIRECTORY: Readonly<Record<string, string>> = Object.freeze({ 'merchant-a': 'acct-merchant-a', 'merchant-b': 'acct-merchant-b' });

/** Standard base64 of UTF-8 JSON, as an x402 server encodes a header. */
export function b64(json: unknown): string {
  return Buffer.from(typeof json === 'string' ? json : JSON.stringify(json), 'utf8').toString('base64');
}

export function carrierOf(json: unknown, options: { readonly status?: number; readonly name?: string; readonly extra?: readonly (readonly [string, string])[] } = {}): { status: number; headers: [string, string][] } {
  return { status: options.status ?? 402, headers: [[options.name ?? 'PAYMENT-REQUIRED', typeof json === 'string' && json.startsWith('raw:') ? json.slice(4) : b64(json)], ...(options.extra ?? []).map(([name, value]) => [name, value] as [string, string])] };
}

export function requirement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { scheme: 'exact', network: NET_A, amount: '1250', asset: TOKEN, payTo: 'merchant-a', maxTimeoutSeconds: 60, extra: { instrument: 'inv-1' }, ...overrides };
}

export function paymentRequired(accepts: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url: RESOURCE_URL, description: 'Quarterly report 42', mimeType: 'application/json', serviceName: 'Merchant Reports', tags: ['reports', 'finance'] },
    accepts,
    ...overrides,
  };
}

export interface BindingLog {
  readonly interpreted: X402BindingRequest[];
  readonly prepared: string[];
}

/** A crypto-free binding: instrument from `extra.instrument`, destination from the trusted directory, a few scripted refusals. */
export function testBinding(log: BindingLog = { interpreted: [], prepared: [] }, flows: readonly ('authorization' | 'upfront')[] = ['authorization', 'upfront']): X402NetworkBinding {
  return {
    bindingId: 'test-binding',
    paymentFlows: flows,
    defaultPaymentFlow: 'authorization',
    supports: (kind) => kind.scheme === 'exact' && (kind.network === NET_A || kind.network === NET_B) && (kind.asset === TOKEN || kind.asset === 'TOKB'),
    async prepare(requirement) {
      log.prepared.push(requirement.payTo);
    },
    interpret(request): X402BindingAnswer {
      log.interpreted.push(request);
      const extra = request.requirement.extra ?? {};
      if (extra['expired'] === true) return { usable: false, refusal: 'challenge-expired' };
      if (extra['bind'] === 'mismatch') return { usable: false, refusal: 'request-binding-mismatch' };
      if (extra['garbage'] === true) return { usable: true, destination: { kind: 'test-account', reference: 'x' }, instrument: 'x', authorized: true } as unknown as X402BindingAnswer;
      const reference = DIRECTORY[request.requirement.payTo];
      if (reference === undefined) return { usable: false, refusal: 'counterparty-unresolved' };
      const instrument = extra['instrument'];
      if (typeof instrument !== 'string') return { usable: false, refusal: 'normalization-failed' };
      return { usable: true, destination: { kind: 'test-account', reference }, instrument: `${request.requirement.network}:${instrument}` };
    },
  };
}

export const MAPPING_A: X402ExecutionMapping = Object.freeze<X402ExecutionMapping>({ scheme: 'exact', network: NET_A, asset: TOKEN, unit: UNIT_A, atomicScale: 6, bindingId: 'test-binding', paymentFlows: ['authorization', 'upfront'], maximumTimeoutSeconds: 300, rail: 'test-rail-a' });
export const MAPPING_B: X402ExecutionMapping = Object.freeze<X402ExecutionMapping>({ scheme: 'exact', network: NET_B, asset: TOKEN, unit: UNIT_B, atomicScale: 2, bindingId: 'test-binding', paymentFlows: ['authorization'], maximumTimeoutSeconds: 120, rail: 'test-rail-b' });

export function adapterWith(options: { readonly mappings?: readonly X402ExecutionMapping[]; readonly log?: BindingLog; readonly fields?: Readonly<Record<string, string | null>>; readonly url?: string } = {}): X402PaymentProtocolAdapter {
  return createX402PaymentProtocolAdapter({
    mappings: options.mappings ?? [MAPPING_A, MAPPING_B],
    bindings: [testBinding(options.log)],
    resolveRequest: ({ target }) => (target === TARGET ? { url: options.url ?? RESOURCE_URL, fields: options.fields ?? {} } : undefined),
    assets: ASSETS,
  });
}

export function contextFor(request: { readonly target?: string; readonly method?: string; readonly contentDigest?: string } = {}): PaymentProtocolInterpretationContext {
  const protectedRequest = readPaymentProtectedRequest({ target: request.target ?? TARGET, method: request.method ?? 'GET', ...(request.contentDigest !== undefined ? { contentDigest: request.contentDigest } : {}) });
  if (protectedRequest === undefined) throw new Error('test protected request invalid');
  return Object.freeze({ organizationId: 'org-x402', businessOperationId: 'bop-1', protectedRequest, observedAtEpochMilliseconds: 1_760_000_000_000 });
}
