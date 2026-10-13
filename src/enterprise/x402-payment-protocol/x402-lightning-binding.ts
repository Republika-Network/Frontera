import { createHash } from 'node:crypto';

import type { X402BindingAnswer, X402BindingRefusal, X402BindingRequest, X402NetworkBinding, X402PaymentRequirements } from '../../features/payment-runtime/protocols/x402/index.js';
import {
  BOLT11_ABSOLUTE_MAXIMUM_LENGTH,
  LIGHTNING_MAXIMUM_MSAT,
  decodeBolt11Invoice,
  isLightningNodePublicKey,
  isLightningPaymentHash,
  lightningDestinationOf,
  type Bolt11Invoice,
  type LightningDestination,
  type LightningInvoiceSource,
  type LightningNetwork,
} from '../../features/payment-runtime/rails/lightning/index.js';

/**
 * PAY-08 — x402 `exact` on Bitcoin Lightning (`lnbtc`), the one network
 * binding PAY-08 ships: the paying side's half of
 * `specs/schemes/exact/scheme_exact_lnbtc.md` (x402 `f8f8330`).
 *
 * ```
 * accepts[] entry the trusted mapping routed here
 *   → scheme exact, concrete lnbtc network, asset BTC, positive integral msat,
 *     compressed payTo, paymentFlow upfront (explicit), method bolt11
 *   → http:1 request hash, computed from the TRUSTED request          never the merchant's echo
 *     (method, exact URL, body SHA-256 from the RFC 9530 digest, bound header values)
 *   → extra.requestHash = computed = the invoice's signed description hash
 *   → the invoice, verified by PAY-06's strict decoder (signature, payee recovery):
 *     currency = network, amount = amount, payee = payTo, expiry = maxTimeoutSeconds,
 *     created no later than now + skew, not expired
 *   → destination  lightning-invoice:<payTo>:<payment hash>       PAY-06's governed destination
 *     instrument   <network>:<payment hash>                       the scheme's consumption key
 * ```
 *
 * ## Why Lightning is executable and the flow is `upfront`
 *
 * `lnbtc` is a *client-submitted* method: the payer pays the invoice itself and
 * presents the preimage as proof. That is exactly what PAY-06's governed
 * `PaymentRail` does — so the money moves only through the existing rail,
 * under a grant, once, and the x402 payload is built afterwards from a payment
 * PAY-05 has already verified as final. No signed-but-unsubmitted payment
 * authority ever leaves Frontera. The scheme defines only `upfront` (payment
 * before the resource runs): that is the flow this binding supports, and the
 * only one.
 *
 * ## Why verification is prepared, then read
 *
 * PAY-04's port is synchronous; PAY-06's BOLT11 decoder verifies signatures
 * asynchronously. A decoding is a pure function of the invoice text, so the
 * paying side `prepare`s every candidate (awaiting PAY-06's own decoder) and
 * `interpret` reads only that memo: an invoice that was not prepared, or did
 * not verify, is refused. The memo also serves the rail as its trusted invoice
 * source — only invoices that verified, by payment hash and payee, ever.
 *
 * ## One payment hash, one invoice text
 *
 * The rail asks for an invoice by payment hash and payee only; the binding
 * verified one exact invoice **text** (its signature, signed description
 * hash, payee, amount, network, expiry). Two validly signed texts may share a
 * payment hash, payee, amount and network and differ in what they commit to.
 * So the memo tracks, per (payee, payment hash) — exactly what the rail asks
 * by — the identity (SHA-256) of the one text it has verified, and a second,
 * different text makes that pair **ambiguous**: from then on neither text is
 * a reading for `interpret` nor an invoice for the rail. Never first-, last-
 * or latest-wins. Only the payee's own key can sign a second text for its
 * pair; another node reusing the payment hash is another pair, and can neither
 * be substituted for this one nor poison it. The identity record is not
 * evicted with the readings (so cache pressure can never turn an ambiguous
 * pair, or a pair whose governed text was evicted, back into a fresh one); it
 * is bounded separately, and once full the memo refuses every new pair rather
 * than forget an old one.
 *
 * The memo is process memory, never authority: it is a pure verification
 * cache and the rail's invoice source, and it can only withhold. A restart
 * starts it empty — a payment governed before the restart is never resumed
 * through it, and a re-presentation is verified again, while PAY-04's
 * one-instrument-one-operation record and PAY-06's durable payment-hash
 * interlock still hold across the restart.
 */

/** The concrete `lnbtc` networks the pinned binding defines, and the BOLT11 currency each must carry. */
export const X402_LNBTC_NETWORKS: Readonly<Record<'mainnet' | 'testnet', { readonly network: string; readonly bolt11: LightningNetwork }>> = Object.freeze({
  mainnet: Object.freeze({ network: 'lnbtc:000000000019d6689c085ae165831e93', bolt11: 'mainnet' }),
  testnet: Object.freeze({ network: 'lnbtc:000000000933ea01ad0ee984209779ba', bolt11: 'testnet' }),
});

export const X402_LNBTC_ASSET = 'BTC';
export const X402_LNBTC_SCHEME = 'exact';
export const X402_LNBTC_TRANSFER_METHOD = 'bolt11';
/** The only request-binding profile this binding implements. `mcp:1` is unsupported (refused). */
export const X402_LNBTC_HTTP_PROFILE = 'http:1';
/** The spec's mandatory default clock-skew allowance. */
export const X402_LNBTC_DEFAULT_CLOCK_SKEW_SECONDS = 60;
/** The atomic scale of `BTC` in this binding: amounts are millisatoshis, 10^11 per BTC. */
export const X402_LNBTC_ATOMIC_SCALE = 11;

const EXTRA_KEYS: readonly string[] = ['assetTransferMethod', 'paymentFlow', 'invoice', 'requestHash', 'requestBindingProfile', 'requestBindingParams'];
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const EMPTY_SHA256 = createHash('sha256').update(new Uint8Array(0)).digest('hex');

/** The memo of verified invoices: PAY-06's decoder, awaited once per invoice text. Not a store; nothing durable. */
export interface X402LightningInvoiceVerifier {
  /** Verifies one invoice text with PAY-06's strict decoder and remembers the reading. Never throws. */
  verify(invoice: unknown): Promise<void>;
  /** The verified reading of exactly this text, when `verify` established one and no other text shares its payment hash. */
  verified(invoice: string): Bolt11Invoice | undefined;
  /** A trusted Lightning invoice source over the verified invoices — by payment hash **and** payee, and only the one text verified for that hash. */
  readonly invoices: LightningInvoiceSource;
}

/** A (payee, payment hash) pair's state: the identity of its one verified text, or ambiguous for the process lifetime. */
const AMBIGUOUS = Symbol('ambiguous');

export function createX402LightningInvoiceVerifier(options: { readonly maximumEntries?: number; readonly maximumLength?: number; readonly maximumPaymentHashes?: number } = {}): X402LightningInvoiceVerifier {
  const maximumEntries = options.maximumEntries ?? 256;
  const maximumLength = options.maximumLength ?? BOLT11_ABSOLUTE_MAXIMUM_LENGTH;
  const maximumPaymentHashes = options.maximumPaymentHashes ?? 16_384;
  if (!Number.isSafeInteger(maximumEntries) || maximumEntries <= 0 || maximumEntries > 4_096) throw new TypeError('maximumEntries must be between 1 and 4096.');
  if (!Number.isSafeInteger(maximumLength) || maximumLength <= 0 || maximumLength > BOLT11_ABSOLUTE_MAXIMUM_LENGTH) throw new TypeError('maximumLength is outside the BOLT11 bound.');
  if (!Number.isSafeInteger(maximumPaymentHashes) || maximumPaymentHashes < maximumEntries || maximumPaymentHashes > 262_144) throw new TypeError('maximumPaymentHashes (payee and payment-hash pairs) must be between maximumEntries and 262144.');
  /** Text → reading (or `null`: did not verify). Bounded; evicted oldest first. */
  const readings = new Map<string, Bolt11Invoice | null>();
  /** `<payee>:<payment hash>` → SHA-256 of its one verified text, or AMBIGUOUS. Never evicted. */
  const identities = new Map<string, string | typeof AMBIGUOUS>();
  const pairOf = (invoice: Bolt11Invoice): string => `${invoice.payee}:${invoice.paymentHash}`;

  /** Records `text` as verified for its pair; `false` when the pair is (or now becomes) ambiguous, or the record is full. */
  const claim = (text: string, invoice: Bolt11Invoice): boolean => {
    const identity = sha256Hex(text);
    const pair = pairOf(invoice);
    const known = identities.get(pair);
    if (known === undefined) {
      if (identities.size >= maximumPaymentHashes) return false;
      identities.set(pair, identity);
      return true;
    }
    if (known === identity) return true;
    identities.set(pair, AMBIGUOUS);
    return false;
  };

  /** The reading of exactly this text, when its pair is still uniquely this text's. */
  const unique = (text: string): Bolt11Invoice | undefined => {
    const reading = readings.get(text);
    if (reading === null || reading === undefined) return undefined;
    return identities.get(pairOf(reading)) === sha256Hex(text) ? reading : undefined;
  };

  return Object.freeze({
    async verify(invoice: unknown): Promise<void> {
      if (typeof invoice !== 'string' || invoice.length === 0 || invoice.length > maximumLength || readings.has(invoice)) return;
      const decoded = await decodeBolt11Invoice(invoice, maximumLength);
      // A second text for a known pair poisons the pair; it is not cached as a reading of its own.
      if (decoded.valid && !claim(invoice, decoded.invoice)) return;
      if (readings.size >= maximumEntries) readings.delete(readings.keys().next().value as string);
      readings.set(invoice, decoded.valid ? decoded.invoice : null);
    },
    verified(invoice: string): Bolt11Invoice | undefined {
      return unique(invoice);
    },
    invoices: Object.freeze({
      async invoiceFor(query: LightningDestination & { readonly executionId: string }): Promise<string | undefined> {
        for (const [text, reading] of readings) {
          if (reading === null || reading.paymentHash !== query.paymentHash || reading.payee !== query.payee) continue;
          // Exactly one text can hold the pair's identity; any other (or an ambiguous pair) is withheld.
          return unique(text) !== undefined ? text : undefined;
        }
        return undefined;
      },
    }),
  });
}

// ─── http:1 request binding ──────────────────────────────────────────────────

const sha256Hex = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** RFC 8785 over the binding object's own kinds (strings, arrays, plain objects). */
function jcs(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${jcs(record[key])}`)
    .join(',')}}`;
}

/** A header value as the trusted network layer states it: printable ASCII, no surrounding whitespace (RFC 9421 §2.1 canonical form). */
const CANONICAL_FIELD_VALUE = /^(?:[!-~](?:[ -~]*[!-~])?)?$/;

/**
 * The `http:1` request hash of a trusted request (scheme_exact_lnbtc.md,
 * "HTTP Profile"), or `undefined` when the request cannot be bound: a
 * body-bearing request without a SHA-256 digest, a bound header the trusted
 * layer did not describe, a value outside the canonical field form.
 */
export function x402LightningHttpRequestHash(request: X402BindingRequest['request'], boundHeaders: readonly string[]): string | undefined {
  let bodyHash = EMPTY_SHA256;
  if (request.bodyBearing) {
    const encoded = request.contentDigest?.algorithms['sha-256'];
    if (encoded === undefined) return undefined;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32) return undefined;
    bodyHash = bytes.toString('hex');
  }
  const headers: { readonly name: string; readonly valueHash: string }[] = [];
  for (const name of boundHeaders) {
    if (!Object.prototype.hasOwnProperty.call(request.fields, name)) return undefined;
    const value = request.fields[name];
    if (value === null || value === undefined) {
      headers.push({ name, valueHash: sha256Hex(Uint8Array.of(0x00)) });
      continue;
    }
    if (!CANONICAL_FIELD_VALUE.test(value)) return undefined;
    headers.push({ name, valueHash: sha256Hex(Buffer.concat([Uint8Array.of(0x01), Buffer.from(value, 'ascii')])) });
  }
  const binding = { domain: `x402:exact:lnbtc:bolt11:${X402_LNBTC_HTTP_PROFILE}`, method: request.method, url: request.url, bodyHash, headers };
  return sha256Hex(Buffer.from(jcs(binding), 'utf8'));
}

/** `requestBindingParams` for `http:1`: exactly `{ headers }`, lower-case field names in strictly ascending byte order, never `payment-signature`. */
function boundHeadersOf(raw: unknown): readonly string[] | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.length !== 1 || keys[0] !== 'headers') return undefined;
  const headers = (raw as { readonly headers?: unknown }).headers;
  if (!Array.isArray(headers) || headers.length > 32) return undefined;
  let previous = '';
  for (const name of headers as unknown[]) {
    if (typeof name !== 'string' || !HEADER_NAME.test(name) || name === 'payment-signature' || name <= previous) return undefined;
    previous = name;
  }
  return Object.freeze([...(headers as string[])]);
}

// ─── the binding ─────────────────────────────────────────────────────────────

export interface X402LightningBindingOptions {
  /** Which concrete `lnbtc` network this deployment's Lightning rail pays on. */
  readonly network: keyof typeof X402_LNBTC_NETWORKS;
  readonly verifier: X402LightningInvoiceVerifier;
  readonly clockSkewSeconds?: number;
}

/** The binding id for a concrete network (what a mapping names). */
export function x402LightningBindingId(network: keyof typeof X402_LNBTC_NETWORKS): string {
  return `x402-exact-lnbtc.${network}`;
}

const refused = (refusal: X402BindingRefusal): X402BindingAnswer => ({ usable: false, refusal });

export function createX402LightningBinding(options: X402LightningBindingOptions): X402NetworkBinding {
  const concrete = X402_LNBTC_NETWORKS[options?.network];
  if (concrete === undefined) throw new TypeError('An lnbtc binding names mainnet or testnet — the networks the pinned binding defines.');
  const verifier = options.verifier;
  if (verifier === null || typeof verifier !== 'object' || typeof verifier.verified !== 'function' || typeof verifier.verify !== 'function') throw new TypeError('An lnbtc binding needs its invoice verifier.');
  const skew = options.clockSkewSeconds ?? X402_LNBTC_DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isSafeInteger(skew) || skew < 0 || skew > 600) throw new TypeError('clockSkewSeconds must be between 0 and 600.');
  const invoiceOf = (requirement: X402PaymentRequirements): unknown => (requirement.extra !== undefined && Object.prototype.hasOwnProperty.call(requirement.extra, 'invoice') ? requirement.extra['invoice'] : undefined);

  return Object.freeze({
    bindingId: x402LightningBindingId(options.network),
    paymentFlows: Object.freeze(['upfront'] as const),
    defaultPaymentFlow: 'upfront' as const,
    supports: (kind: { readonly scheme: string; readonly network: string; readonly asset: string }) => kind.scheme === X402_LNBTC_SCHEME && kind.network === concrete.network && kind.asset === X402_LNBTC_ASSET,
    prepare: async (requirement: X402PaymentRequirements): Promise<void> => verifier.verify(invoiceOf(requirement)),

    interpret(request: X402BindingRequest): X402BindingAnswer {
      const requirement = request.requirement;
      if (requirement.scheme !== X402_LNBTC_SCHEME || requirement.network !== concrete.network || requirement.asset !== X402_LNBTC_ASSET) return refused('challenge-unsupported');
      if (request.paymentFlow !== 'upfront') return refused('challenge-unsupported');
      const extra = requirement.extra;
      if (extra === undefined || !Object.keys(extra).every((key) => EXTRA_KEYS.includes(key))) return refused('challenge-unsupported');
      // The server MUST state the flow; a missing one is not defaulted here.
      if (extra['paymentFlow'] !== 'upfront') return refused('challenge-unsupported');
      if (extra['assetTransferMethod'] !== undefined && extra['assetTransferMethod'] !== X402_LNBTC_TRANSFER_METHOD) return refused('challenge-unsupported');
      if (extra['requestBindingProfile'] !== X402_LNBTC_HTTP_PROFILE) return refused(extra['requestBindingProfile'] === undefined ? 'request-binding-mismatch' : 'challenge-unsupported');
      if (!isLightningNodePublicKey(requirement.payTo)) return refused('normalization-failed');
      const amountMsat = BigInt(requirement.amount);
      if (amountMsat <= 0n || amountMsat > LIGHTNING_MAXIMUM_MSAT) return refused('normalization-failed');

      // The request binding: computed from the trusted request, then compared with what the server says it bound.
      const stated = extra['requestHash'];
      const boundHeaders = boundHeadersOf(extra['requestBindingParams']);
      if (typeof stated !== 'string' || !isLightningPaymentHash(stated) || boundHeaders === undefined) return refused('request-binding-mismatch');
      const computed = x402LightningHttpRequestHash(request.request, boundHeaders);
      if (computed === undefined || computed !== stated) return refused('request-binding-mismatch');

      // The invoice: only a reading PAY-06's decoder established during preparation.
      const text = extra['invoice'];
      if (typeof text !== 'string' || text.length === 0) return refused('normalization-failed');
      const invoice = verifier.verified(text);
      if (invoice === undefined) return refused('normalization-failed');
      if (invoice.network !== concrete.bolt11) return refused('normalization-failed');
      if (invoice.amountMsat === undefined || invoice.amountMsat !== amountMsat) return refused('normalization-failed');
      if (invoice.descriptionHash === undefined || invoice.descriptionHash !== computed) return refused('request-binding-mismatch');
      if (invoice.payee !== requirement.payTo) return refused('counterparty-unresolved');
      if (invoice.expirySeconds !== requirement.maxTimeoutSeconds) return refused('normalization-failed');
      const nowSeconds = Math.floor(request.observedAtEpochMilliseconds / 1000);
      if (invoice.timestamp > nowSeconds + skew) return refused('normalization-failed');
      if (nowSeconds >= invoice.timestamp + invoice.expirySeconds) return refused('challenge-expired');

      return {
        usable: true,
        destination: lightningDestinationOf(requirement.payTo, invoice.paymentHash),
        instrument: `${concrete.network}:${invoice.paymentHash}`,
      };
    },
  });
}
