import {
  X402JsonNumber,
  decodeX402JsonHeader,
  encodeX402JsonHeader,
  isX402JsonObject,
  serializeX402Json,
  x402IntegerOf,
  type X402Json,
  type X402JsonObject,
} from './x402-codec.js';

/**
 * PAY-08 — the x402 v2 core types (`x402-specification-v2.md` §5) and their
 * HTTP representation (`transports-v2/http.md`), read **closed** on the
 * paying side.
 *
 * Pinned baseline: `x402-foundation/x402` at
 * `f8f83309706b14cc696962f0a002eeeb66c3dc26` (2026-10-10), protocol version 2.
 * Version 1 is not read: a message whose `x402Version` is not exactly `2` is
 * refused, and the deprecated v1 header names (`X-PAYMENT`,
 * `X-PAYMENT-RESPONSE`) are never consulted.
 *
 * Every field is untrusted merchant data. Parsing establishes only that a
 * message is well formed and bounded; it never establishes that its terms may
 * be paid. Display metadata (`error`, `description`, `mimeType`,
 * `serviceName`, `tags`, `iconUrl`) is validated for its bounds and then
 * dropped: it reaches neither interpretation, selection, evidence nor a store.
 */

export const X402_VERSION = 2;

/** The x402 v2 HTTP headers — exactly these names (compared case-insensitively, as HTTP field names are). */
export const X402_HTTP_HEADERS = Object.freeze({
  /** Server → client, with status 402: base64 `PaymentRequired`. */
  paymentRequired: 'PAYMENT-REQUIRED',
  /** Client → server: base64 `PaymentPayload`. Bearer proof of payment — never logged, never stored. */
  paymentSignature: 'PAYMENT-SIGNATURE',
  /** Server → client: base64 `SettlementResponse`. Protocol evidence, never Frontera settlement. */
  paymentResponse: 'PAYMENT-RESPONSE',
});

/** The status an x402 payment requirement is signalled with. */
export const X402_PAYMENT_REQUIRED_STATUS = 402;

/** Bounds on every x402 message field, refused before anything else is done with it. */
export const X402_MESSAGE_LIMITS = Object.freeze({
  maxResponseHeaders: 64,
  maxHeaderNameLength: 64,
  maxAccepts: 16,
  maxUrlLength: 2_048,
  maxDescriptionLength: 1_024,
  maxErrorLength: 1_024,
  maxMimeTypeLength: 128,
  /** The spec's own: printable ASCII, at most 32 characters. */
  maxServiceNameLength: 32,
  maxTags: 5,
  maxTagLength: 32,
  maxSchemeLength: 32,
  /** CAIP-2: an 8-character namespace, `:`, a 32-character reference. */
  maxNetworkLength: 41,
  maxAssetLength: 128,
  maxPayToLength: 256,
  /** Atomic units, decimal digits. */
  maxAmountLength: 40,
  /** A day. A requirement asking for longer is not well formed here (trusted mappings bound it further). */
  maxTimeoutSeconds: 86_400,
  maxExtraMembers: 16,
  maxExtraBytes: 4_096,
  maxExtensions: 8,
  maxExtensionNameLength: 64,
  maxExtensionBytes: 4_096,
  maxExtensionsBytes: 6_144,
  maxTransactionLength: 256,
  maxErrorReasonLength: 128,
  maxPayloadMembers: 8,
  maxPayloadValueLength: 2_048,
});

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const PRINTABLE_ASCII = /^[ -~]+$/;
const SCHEME = /^[a-z0-9][a-z0-9-]*$/;
/** CAIP-2 `chain_id`: `namespace:reference`. */
const CAIP2 = /^([-a-z0-9]{3,8}):([-_a-zA-Z0-9]{1,32})$/;
/** An atomic-unit amount as the core types state it: decimal digits, positive, no leading zero, no sign, point, exponent or separator. */
const ATOMIC_AMOUNT = /^[1-9][0-9]*$/;
const TOKEN_ASCII = /^[!-~]+$/;
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+-]+|"[^"\\\u0000-\u001f]*"))*$/;
const EXTENSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ERROR_REASON = /^[a-z0-9_]+$/;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

export type X402Parse<T> = { readonly valid: true; readonly value: T } | { readonly valid: false; readonly violation: string };

class Violation {
  constructor(readonly violation: string) {}
}

const violate = (violation: string): never => {
  throw new Violation(violation);
};

function caught<T>(read: () => T): X402Parse<T> {
  try {
    return { valid: true, value: read() };
  } catch (error) {
    return { valid: false, violation: error instanceof Violation ? error.violation : 'malformed' };
  }
}

/** The members of a codec object, closed against `allowed`; every name in `required` present. */
function members(value: X402Json | undefined, allowed: readonly string[], required: readonly string[], where: string): ReadonlyMap<string, X402Json> {
  if (!isX402JsonObject(value)) return violate(`${where}-not-object`);
  const out = new Map<string, X402Json>();
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) violate(`${where}-unknown-member`);
    out.set(key, value[key] as X402Json);
  }
  for (const key of required) if (!out.has(key)) violate(`${where}-missing-${key}`);
  return out;
}

function boundedText(value: X402Json | undefined, maximum: number, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || CONTROL.test(value) || value !== value.trim()) return violate(`${where}-invalid`);
  return value;
}

/** A CAIP-2 chain id, by its own grammar (any namespace — parsing a network is not supporting it). */
export function isX402Network(value: unknown): value is string {
  return typeof value === 'string' && value.length <= X402_MESSAGE_LIMITS.maxNetworkLength && CAIP2.test(value);
}

/** An atomic-unit amount: positive decimal digits, no leading zero, bounded. */
export function isX402AtomicAmount(value: unknown): value is string {
  return typeof value === 'string' && value.length <= X402_MESSAGE_LIMITS.maxAmountLength && ATOMIC_AMOUNT.test(value);
}

/**
 * An absolute `https` / `http` URL in ASCII URI syntax, kept exactly as
 * written: no fragment, no user information, no whitespace or control
 * character. Nothing is normalized — no case folding, no percent-decoding,
 * no reordering, no default-port removal: two spellings are two resources.
 */
export function isX402ResourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > X402_MESSAGE_LIMITS.maxUrlLength) return false;
  if (!/^[!-~]+$/.test(value) || value.includes('#')) return false;
  const match = /^(https?):\/\/([^/?#]*)(.*)$/.exec(value);
  if (match === null) return false;
  const authority = match[2] ?? '';
  if (authority.length === 0 || authority.includes('@')) return false;
  if (!/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$/.test(authority)) return false;
  const rest = match[3] ?? '';
  return rest === '' || rest.startsWith('/') || rest.startsWith('?');
}

// ─── the core types ─────────────────────────────────────────────────────────

/** `ResourceInfo` — only the URL is material; the rest was validated and dropped. */
export interface X402ResourceInfo {
  readonly url: string;
}

/** One `PaymentRequirements` — every field exact as stated; `extra` an opaque, bounded, frozen object. */
export interface X402PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra?: X402JsonObject;
}

/** `PaymentRequired` as read: version, the material resource, the offers, and extensions (protocol data, never authority). */
export interface X402PaymentRequired {
  readonly x402Version: typeof X402_VERSION;
  readonly resource: X402ResourceInfo;
  readonly accepts: readonly X402PaymentRequirements[];
  readonly extensions?: X402JsonObject;
}

const PAYMENT_REQUIRED_KEYS: readonly string[] = ['x402Version', 'error', 'resource', 'accepts', 'extensions'];
const RESOURCE_KEYS: readonly string[] = ['url', 'description', 'mimeType', 'serviceName', 'tags', 'iconUrl'];
const REQUIREMENT_KEYS: readonly string[] = ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds', 'extra'];
const EXTENSION_KEYS: readonly string[] = ['info', 'schema'];

function readVersion(value: X402Json | undefined): typeof X402_VERSION {
  if (x402IntegerOf(value, 1_000) !== X402_VERSION) violate('version-unsupported');
  return X402_VERSION;
}

function readResource(value: X402Json | undefined): X402ResourceInfo {
  const fields = members(value, RESOURCE_KEYS, ['url'], 'resource');
  const url = fields.get('url');
  if (!isX402ResourceUrl(url)) return violate('resource-url-invalid');
  if (fields.has('description')) boundedText(fields.get('description'), X402_MESSAGE_LIMITS.maxDescriptionLength, 'resource-description');
  if (fields.has('mimeType')) {
    const mimeType = boundedText(fields.get('mimeType'), X402_MESSAGE_LIMITS.maxMimeTypeLength, 'resource-mime-type');
    if (!MIME_TYPE.test(mimeType)) violate('resource-mime-type-invalid');
  }
  if (fields.has('serviceName')) {
    const name = boundedText(fields.get('serviceName'), X402_MESSAGE_LIMITS.maxServiceNameLength, 'resource-service-name');
    if (!PRINTABLE_ASCII.test(name)) violate('resource-service-name-invalid');
  }
  if (fields.has('tags')) {
    const tags = fields.get('tags');
    if (!Array.isArray(tags) || tags.length > X402_MESSAGE_LIMITS.maxTags) violate('resource-tags-invalid');
    for (const tag of tags as readonly X402Json[]) if (!PRINTABLE_ASCII.test(boundedText(tag, X402_MESSAGE_LIMITS.maxTagLength, 'resource-tag'))) violate('resource-tag-invalid');
  }
  if (fields.has('iconUrl') && !isX402ResourceUrl(fields.get('iconUrl'))) violate('resource-icon-url-invalid');
  return Object.freeze({ url });
}

/** The serialized size of a codec value, bounded; numbers inside protocol objects must be canonical integers when `integersOnly`. */
function boundedObject(value: X402Json | undefined, maxMembers: number, maxBytes: number, where: string, integersOnly: boolean): X402JsonObject {
  if (!isX402JsonObject(value) || Object.keys(value).length > maxMembers) return violate(`${where}-invalid`);
  const text = serializeX402Json(value);
  if (text === undefined || text.length > maxBytes) return violate(`${where}-oversized`);
  if (integersOnly && !numbersAreIntegers(value)) violate(`${where}-number-invalid`);
  return value;
}

function numbersAreIntegers(value: X402Json): boolean {
  if (value instanceof X402JsonNumber) return /^-?(?:0|[1-9][0-9]{0,15})$/.test(value.text);
  if (Array.isArray(value)) return (value as readonly X402Json[]).every(numbersAreIntegers);
  if (isX402JsonObject(value)) return Object.keys(value).every((key) => numbersAreIntegers(value[key] as X402Json));
  return true;
}

/** One `PaymentRequirements`, closed. Exported for the PaymentPayload `accepted` reading, which must be the very same shape. */
export function readX402Requirements(value: X402Json | undefined, where = 'requirement'): X402PaymentRequirements {
  const fields = members(value, REQUIREMENT_KEYS, ['scheme', 'network', 'amount', 'asset', 'payTo', 'maxTimeoutSeconds'], where);
  const scheme = boundedText(fields.get('scheme'), X402_MESSAGE_LIMITS.maxSchemeLength, `${where}-scheme`);
  if (!SCHEME.test(scheme)) violate(`${where}-scheme-invalid`);
  const network = fields.get('network');
  if (!isX402Network(network)) return violate(`${where}-network-invalid`);
  const amount = fields.get('amount');
  if (!isX402AtomicAmount(amount)) return violate(`${where}-amount-invalid`);
  const asset = boundedText(fields.get('asset'), X402_MESSAGE_LIMITS.maxAssetLength, `${where}-asset`);
  if (!TOKEN_ASCII.test(asset)) violate(`${where}-asset-invalid`);
  const payTo = boundedText(fields.get('payTo'), X402_MESSAGE_LIMITS.maxPayToLength, `${where}-pay-to`);
  if (!TOKEN_ASCII.test(payTo)) violate(`${where}-pay-to-invalid`);
  const maxTimeoutSeconds = x402IntegerOf(fields.get('maxTimeoutSeconds'), X402_MESSAGE_LIMITS.maxTimeoutSeconds);
  if (maxTimeoutSeconds === undefined || maxTimeoutSeconds <= 0) return violate(`${where}-timeout-invalid`);
  const extra = fields.has('extra') ? boundedObject(fields.get('extra'), X402_MESSAGE_LIMITS.maxExtraMembers, X402_MESSAGE_LIMITS.maxExtraBytes, `${where}-extra`, true) : undefined;
  if (extra !== undefined) {
    // Protocol-reserved keys (spec §6.1): interpreted as defined there, never as scheme-private data.
    for (const reserved of ['paymentFlow', 'assetTransferMethod']) {
      if (Object.prototype.hasOwnProperty.call(extra, reserved)) boundedText(extra[reserved], 64, `${where}-${reserved === 'paymentFlow' ? 'payment-flow' : 'asset-transfer-method'}`);
    }
  }
  return Object.freeze({ scheme, network, amount, asset, payTo, maxTimeoutSeconds, ...(extra !== undefined ? { extra } : {}) });
}

function readExtensions(value: X402Json | undefined): X402JsonObject {
  if (!isX402JsonObject(value)) return violate('extensions-not-object');
  const names = Object.keys(value);
  if (names.length > X402_MESSAGE_LIMITS.maxExtensions) violate('extensions-too-many');
  for (const name of names) {
    if (name.length > X402_MESSAGE_LIMITS.maxExtensionNameLength || !EXTENSION_NAME.test(name)) violate('extension-name-invalid');
    const extension = members(value[name], EXTENSION_KEYS, EXTENSION_KEYS, 'extension');
    if (!isX402JsonObject(extension.get('info')) || !isX402JsonObject(extension.get('schema'))) violate('extension-invalid');
    const text = serializeX402Json(value[name]);
    if (text === undefined || text.length > X402_MESSAGE_LIMITS.maxExtensionBytes) violate('extension-oversized');
  }
  const total = serializeX402Json(value);
  if (total === undefined || total.length > X402_MESSAGE_LIMITS.maxExtensionsBytes) violate('extensions-oversized');
  return value;
}

/** A decoded `PaymentRequired` JSON value, read closed. */
export function readX402PaymentRequired(value: X402Json): X402Parse<X402PaymentRequired> {
  return caught(() => {
    const fields = members(value, PAYMENT_REQUIRED_KEYS, ['x402Version', 'resource', 'accepts'], 'payment-required');
    // The version is read first: a v1 (or future) document is refused as such, whatever else it says.
    const x402Version = readVersion(fields.get('x402Version'));
    if (fields.has('error')) boundedText(fields.get('error'), X402_MESSAGE_LIMITS.maxErrorLength, 'error');
    const resource = readResource(fields.get('resource'));
    const accepts = fields.get('accepts');
    if (!Array.isArray(accepts)) return violate('accepts-invalid');
    if (accepts.length === 0) violate('accepts-empty');
    if (accepts.length > X402_MESSAGE_LIMITS.maxAccepts) violate('accepts-too-many');
    const requirements = Object.freeze((accepts as readonly X402Json[]).map((entry) => readX402Requirements(entry)));
    const extensions = fields.has('extensions') ? readExtensions(fields.get('extensions')) : undefined;
    return Object.freeze({ x402Version, resource, accepts: requirements, ...(extensions !== undefined && Object.keys(extensions).length > 0 ? { extensions } : {}) });
  });
}

/** One `PAYMENT-REQUIRED` header value → `PaymentRequired`: canonical base64, fatal UTF-8, strict JSON, closed types. */
export function decodeX402PaymentRequiredHeader(value: unknown): X402Parse<X402PaymentRequired> {
  const decoded = decodeX402JsonHeader(value);
  if (!decoded.valid) return decoded;
  return readX402PaymentRequired(decoded.value);
}

/**
 * The canonical form of one requirement — the JSON object an echo carries,
 * serialized canonically. Independent of member order and base64 spelling,
 * sensitive to every field and every `extra` member.
 */
export function canonicalX402Requirements(requirement: X402PaymentRequirements): string {
  const object = Object.create(null) as Record<string, X402Json>;
  object['scheme'] = requirement.scheme;
  object['network'] = requirement.network;
  object['amount'] = requirement.amount;
  object['asset'] = requirement.asset;
  object['payTo'] = requirement.payTo;
  object['maxTimeoutSeconds'] = new X402JsonNumber(String(requirement.maxTimeoutSeconds));
  if (requirement.extra !== undefined) object['extra'] = requirement.extra;
  const text = serializeX402Json(object);
  if (text === undefined) throw new TypeError('A requirement that was read is always serializable.');
  return text;
}

// ─── the HTTP response carrier ──────────────────────────────────────────────

/**
 * What the paying side hands the adapter: the merchant's response status and
 * header fields, exactly as received. Untrusted. Exactly one
 * `PAYMENT-REQUIRED` field (name compared case-insensitively) with status
 * `402`; two fields — even identical ones — are refused, never merged or
 * first-wins.
 */
export interface X402ResponseCarrier {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
}

function ownData(raw: unknown, allowed: readonly string[]): Map<string, unknown> | undefined {
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const prototype = Object.getPrototypeOf(raw) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const out = new Map<string, unknown>();
    for (const key of Reflect.ownKeys(raw)) {
      if (typeof key !== 'string' || !allowed.includes(key)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      out.set(key, descriptor.value as unknown);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** A plain array's elements, each read from its own data descriptor, or `undefined`. Never runs a getter. */
function ownElements(raw: unknown, maximum: number): unknown[] | undefined {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return undefined;
    const length = (Object.getOwnPropertyDescriptor(raw, 'length') as PropertyDescriptor | undefined)?.value as unknown;
    if (typeof length !== 'number' || length > maximum) return undefined;
    const out: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (descriptor === undefined || !('value' in descriptor)) return undefined;
      out.push(descriptor.value as unknown);
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The value of the one field named `name` (case-insensitively) in a carrier, `undefined` when absent, or a violation. */
function singleHeader(raw: unknown, name: string): X402Parse<string | undefined> {
  const entries = ownElements(raw, X402_MESSAGE_LIMITS.maxResponseHeaders);
  if (entries === undefined) return { valid: false, violation: 'carrier-headers-invalid' };
  let found: string | undefined;
  for (const entry of entries) {
    const pair = ownElements(entry, 2);
    if (pair?.length !== 2) return { valid: false, violation: 'carrier-header-invalid' };
    const [fieldName, fieldValue] = pair;
    if (typeof fieldName !== 'string' || typeof fieldValue !== 'string' || fieldName.length === 0 || fieldName.length > X402_MESSAGE_LIMITS.maxHeaderNameLength) return { valid: false, violation: 'carrier-header-invalid' };
    if (fieldName.toLowerCase() !== name.toLowerCase()) continue;
    if (found !== undefined) return { valid: false, violation: 'carrier-header-duplicated' };
    found = fieldValue;
  }
  return { valid: true, value: found };
}

/** A merchant response → its `PaymentRequired`, or a closed violation. The status must be 402 and the field present once. */
export function readX402PaymentRequiredCarrier(raw: unknown): X402Parse<X402PaymentRequired> {
  const fields = ownData(raw, ['status', 'headers']);
  if (fields === undefined) return { valid: false, violation: 'carrier-invalid' };
  if (fields.get('status') !== X402_PAYMENT_REQUIRED_STATUS) return { valid: false, violation: 'carrier-status-not-402' };
  const header = singleHeader(fields.get('headers'), X402_HTTP_HEADERS.paymentRequired);
  if (!header.valid) return header;
  if (header.value === undefined) return { valid: false, violation: 'carrier-payment-required-missing' };
  return decodeX402PaymentRequiredHeader(header.value);
}

// ─── PaymentPayload ─────────────────────────────────────────────────────────

/** `PaymentPayload` as read: `accepted` is a full `PaymentRequirements`; `payload` scheme-specific strings. */
export interface X402PaymentPayload {
  readonly x402Version: typeof X402_VERSION;
  readonly resource?: X402ResourceInfo;
  readonly accepted: X402PaymentRequirements;
  readonly payload: Readonly<Record<string, string>>;
  readonly extensions?: X402JsonObject;
}

const PAYMENT_PAYLOAD_KEYS: readonly string[] = ['x402Version', 'resource', 'accepted', 'payload', 'extensions'];

function readPayloadObject(value: X402Json | undefined): Readonly<Record<string, string>> {
  if (!isX402JsonObject(value)) return violate('payload-not-object');
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > X402_MESSAGE_LIMITS.maxPayloadMembers) violate('payload-invalid');
  const out = Object.create(null) as Record<string, string>;
  for (const key of keys.sort()) {
    if (!PAYLOAD_KEY.test(key)) violate('payload-member-invalid');
    out[key] = boundedText(value[key], X402_MESSAGE_LIMITS.maxPayloadValueLength, 'payload-member');
  }
  return Object.freeze(out);
}

/** A decoded `PaymentPayload` JSON value, read closed. Only string-valued scheme payloads are read. */
export function readX402PaymentPayload(value: X402Json): X402Parse<X402PaymentPayload> {
  return caught(() => {
    const fields = members(value, PAYMENT_PAYLOAD_KEYS, ['x402Version', 'accepted', 'payload'], 'payment-payload');
    const x402Version = readVersion(fields.get('x402Version'));
    const resource = fields.has('resource') ? readResource(fields.get('resource')) : undefined;
    const accepted = readX402Requirements(fields.get('accepted'), 'accepted');
    const payload = readPayloadObject(fields.get('payload'));
    const extensions = fields.has('extensions') ? readExtensions(fields.get('extensions')) : undefined;
    return Object.freeze({ x402Version, ...(resource !== undefined ? { resource } : {}), accepted, payload, ...(extensions !== undefined && Object.keys(extensions).length > 0 ? { extensions } : {}) });
  });
}

/** One `PAYMENT-SIGNATURE` header value → `PaymentPayload` (a resource server's reading; Frontera only builds them). */
export function decodeX402PaymentSignatureHeader(value: unknown): X402Parse<X402PaymentPayload> {
  const decoded = decodeX402JsonHeader(value);
  if (!decoded.valid) return decoded;
  return readX402PaymentPayload(decoded.value);
}

/**
 * The `PAYMENT-SIGNATURE` header value for an accepted requirement, a scheme
 * payload and the server's extensions — pure: no proof is obtained, checked or
 * kept here. Extension echo follows spec §5.1.2 exactly: every extension the
 * server sent is carried unchanged; a client addition may only introduce a
 * **new** name — overwriting or deleting the server's is refused, never merged.
 */
export function encodeX402PaymentSignatureHeader(input: {
  readonly accepted: X402PaymentRequirements;
  readonly payload: Readonly<Record<string, string>>;
  readonly serverExtensions?: X402JsonObject;
  readonly clientExtensions?: X402JsonObject;
}): X402Parse<string> {
  return caught(() => {
    const payload = readPayloadObject(plainCopy(input.payload));
    const extensions = Object.create(null) as Record<string, X402Json>;
    if (input.serverExtensions !== undefined) {
      const server = readExtensions(input.serverExtensions);
      for (const name of Object.keys(server)) extensions[name] = server[name] as X402Json;
    }
    if (input.clientExtensions !== undefined) {
      const client = readExtensions(input.clientExtensions);
      for (const name of Object.keys(client)) {
        if (Object.prototype.hasOwnProperty.call(extensions, name)) violate('extension-overwrite');
        extensions[name] = client[name] as X402Json;
      }
    }
    if (Object.keys(extensions).length > 0) readExtensions(Object.freeze(extensions));
    const document = Object.create(null) as Record<string, X402Json>;
    document['x402Version'] = new X402JsonNumber(String(X402_VERSION));
    document['accepted'] = requirementObject(input.accepted);
    document['payload'] = payload as unknown as X402JsonObject;
    if (Object.keys(extensions).length > 0) document['extensions'] = Object.freeze(extensions);
    const header = encodeX402JsonHeader(document);
    if (header === undefined || header.length > 16_384) violate('payment-signature-oversized');
    return header as string;
  });
}

/** A requirement as a codec object (the shape `accepted` echoes). */
function requirementObject(requirement: X402PaymentRequirements): X402JsonObject {
  const object = Object.create(null) as Record<string, X402Json>;
  object['scheme'] = requirement.scheme;
  object['network'] = requirement.network;
  object['amount'] = requirement.amount;
  object['asset'] = requirement.asset;
  object['payTo'] = requirement.payTo;
  object['maxTimeoutSeconds'] = new X402JsonNumber(String(requirement.maxTimeoutSeconds));
  if (requirement.extra !== undefined) object['extra'] = requirement.extra;
  const frozen = Object.freeze(object);
  // Re-read: what is echoed is exactly what a reader accepts (throws a violation otherwise).
  readX402Requirements(frozen, 'accepted');
  return frozen;
}

/** A caller's plain string record, copied from own data properties into a codec object (never spread, no getter run). */
function plainCopy(raw: unknown): X402JsonObject {
  const out = Object.create(null) as Record<string, X402Json>;
  try {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return violate('payload-not-object');
    const prototype = Object.getPrototypeOf(raw) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return violate('payload-not-object');
    for (const key of Reflect.ownKeys(raw)) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (typeof key !== 'string' || descriptor === undefined || !('value' in descriptor) || typeof descriptor.value !== 'string') return violate('payload-member-invalid');
      out[key] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof Violation) throw error;
    return violate('payload-not-object');
  }
  return Object.freeze(out);
}

// ─── SettlementResponse ─────────────────────────────────────────────────────

/** `SettlementResponse` as read — protocol evidence of what the server says happened. Never Frontera settlement. */
export interface X402SettlementResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly payer?: string;
  /** Empty when nothing was broadcast. */
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
}

const SETTLEMENT_RESPONSE_KEYS: readonly string[] = ['success', 'errorReason', 'payer', 'transaction', 'network', 'amount', 'extensions'];

/** A decoded `SettlementResponse`, read closed. `extensions` are bounded and dropped. */
export function readX402SettlementResponse(value: X402Json): X402Parse<X402SettlementResponse> {
  return caught(() => {
    const fields = members(value, SETTLEMENT_RESPONSE_KEYS, ['success', 'transaction', 'network'], 'settlement-response');
    const success = fields.get('success');
    if (typeof success !== 'boolean') return violate('settlement-response-success-invalid');
    const transaction = fields.get('transaction');
    if (typeof transaction !== 'string' || transaction.length > X402_MESSAGE_LIMITS.maxTransactionLength || !/^[!-~]*$/.test(transaction)) return violate('settlement-response-transaction-invalid');
    const network = fields.get('network');
    if (!isX402Network(network)) return violate('settlement-response-network-invalid');
    let errorReason: string | undefined;
    if (fields.has('errorReason')) {
      errorReason = boundedText(fields.get('errorReason'), X402_MESSAGE_LIMITS.maxErrorReasonLength, 'settlement-response-error-reason');
      if (!ERROR_REASON.test(errorReason)) violate('settlement-response-error-reason-invalid');
    }
    const payer = fields.has('payer') ? boundedText(fields.get('payer'), X402_MESSAGE_LIMITS.maxPayToLength, 'settlement-response-payer') : undefined;
    const amount = fields.get('amount');
    if (amount !== undefined && !isX402AtomicAmount(amount)) violate('settlement-response-amount-invalid');
    if (fields.has('extensions')) readExtensions(fields.get('extensions'));
    if (success && errorReason !== undefined) violate('settlement-response-inconsistent');
    return Object.freeze({
      success,
      ...(errorReason !== undefined ? { errorReason } : {}),
      ...(payer !== undefined ? { payer } : {}),
      transaction,
      network,
      ...(amount !== undefined ? { amount: amount as string } : {}),
    });
  });
}

/** A merchant response → its `PaymentResponse`, when it carries exactly one `PAYMENT-RESPONSE` field. Any status. */
export function readX402PaymentResponseCarrier(raw: unknown): X402Parse<{ readonly status: number; readonly response: X402SettlementResponse }> {
  const fields = ownData(raw, ['status', 'headers']);
  const status = fields?.get('status');
  if (fields === undefined || typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599) return { valid: false, violation: 'carrier-invalid' };
  const header = singleHeader(fields.get('headers'), X402_HTTP_HEADERS.paymentResponse);
  if (!header.valid) return header;
  if (header.value === undefined) return { valid: false, violation: 'carrier-payment-response-missing' };
  const decoded = decodeX402JsonHeader(header.value);
  if (!decoded.valid) return decoded;
  const response = readX402SettlementResponse(decoded.value);
  if (!response.valid) return response;
  return { valid: true, value: Object.freeze({ status, response: response.value }) };
}
