import { createHash, createPublicKey } from 'node:crypto';

import { createAuthoritySignatureRegistry } from '../authority-authenticity/signature-verification.js';
import { EXECUTION_CAPABILITY_LIMITS, isExecutionCapabilityIdentifier, type ExecutionCapabilityTrustedIssuer } from '../execution-capability/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER } from '../execution-capability-presentation/index.js';
import { isRefusedByAdmission } from './admission.js';
import { REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT } from './binding-reconstruction.js';

/**
 * G-02C1A — the reference executor's **closed trust configuration**.
 *
 * One JSON document, read once at boot and validated here, then frozen. It is
 * the executor's own: the Host never writes it, a presented capability never
 * adds to it, and nothing is discovered at runtime — no key fetch, no trust on
 * first use, no issuer key taken from the artifact. Every identity is compared
 * exactly; a `*` is refused wherever an identity is expected.
 *
 * The client credential's **value** is not in the document. The document names
 * an environment variable; its value is read once, reduced to a SHA-256 digest
 * for constant-time comparison, and not retained.
 *
 * Every refusal is a `ReferenceExecutorConfigurationError` whose message names
 * the defect and never echoes a value, a key or a secret.
 *
 * G-02C1A configures verification only: there is no receipt key, receipt
 * ledger or consumption ledger here (G-02C1B, G-02C1C).
 */

export const REFERENCE_EXECUTOR_CONFIGURATION_FORMAT = 'frontera.reference-executor-configuration.v1';

/** The only environment the reference executor runs in: synthetic, CI-only qualification. */
export const REFERENCE_EXECUTOR_ENVIRONMENT = 'reference-synthetic';

/** The methods the Host's Generic HTTP adapter can send. There is no GET: the adapter has none. */
export const REFERENCE_EXECUTOR_METHODS = Object.freeze(['POST', 'PUT', 'PATCH', 'DELETE'] as const);
export type ReferenceExecutorMethod = (typeof REFERENCE_EXECUTOR_METHODS)[number];

export const REFERENCE_EXECUTOR_STATUS_POLICIES = Object.freeze(['offline-only'] as const);

export const REFERENCE_EXECUTOR_CONFIGURATION_ERROR_CODES = Object.freeze([
  'CONFIGURATION_MALFORMED',
  'CONFIGURATION_UNKNOWN_KEY',
  'CONFIGURATION_MISSING_FIELD',
  'CONFIGURATION_FORMAT_UNSUPPORTED',
  'ENVIRONMENT_UNSUPPORTED',
  'IDENTITY_INVALID',
  'IDENTITY_RELATIONSHIP_INVALID',
  'TRUST_REGISTRY_EMPTY',
  'KEY_OWNERSHIP_DUPLICATE',
  'ALGORITHM_UNTRUSTED',
  'PUBLIC_KEY_INVALID',
  'ALLOW_LIST_INVALID',
  'BINDING_FORMAT_UNRECOGNIZED',
  'ORIGIN_INVALID',
  'METHOD_INVALID',
  'CREDENTIAL_INVALID',
  'LIMIT_INVALID',
  'STATUS_POLICY_UNSUPPORTED',
  'RUNTIME_UNSAFE',
] as const);
export type ReferenceExecutorConfigurationErrorCode = (typeof REFERENCE_EXECUTOR_CONFIGURATION_ERROR_CODES)[number];

export class ReferenceExecutorConfigurationError extends Error {
  constructor(
    readonly code: ReferenceExecutorConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReferenceExecutorConfigurationError';
  }
}

export interface ReferenceExecutorOrigin {
  readonly scheme: 'https';
  readonly hostname: string;
  readonly port: number;
  /** Exactly what the Host's transport sends as `Host`: the hostname, plus `:port` unless it is 443. */
  readonly authority: string;
}

export interface ReferenceExecutorCredential {
  /** The lower-case header the client credential arrives in. */
  readonly header: string;
  /** SHA-256 (hex) of the exact expected header value. The value itself is not retained. */
  readonly expectedDigest: string;
}

/** A validated, deep-frozen configuration. */
export interface ReferenceExecutorConfiguration {
  readonly executorId: string;
  readonly audience: string;
  readonly organizationIds: readonly string[];
  readonly trustDomain: string;
  readonly trustedIssuers: readonly ExecutionCapabilityTrustedIssuer[];
  readonly permittedActions: readonly string[];
  readonly permittedResources: readonly string[];
  readonly bindingFormats: readonly string[];
  readonly origin: ReferenceExecutorOrigin;
  readonly methods: readonly ReferenceExecutorMethod[];
  readonly credential: ReferenceExecutorCredential;
  readonly maximumLifetimeMs: number;
  readonly maximumClockSkewMs: number;
  readonly statusPolicy: 'offline-only';
  readonly listen: { readonly host: '127.0.0.1' | '::1'; readonly port: number };
}

const TOP_LEVEL_FIELDS = Object.freeze([
  'format',
  'environment',
  'executorId',
  'audience',
  'organizationIds',
  'trustDomain',
  'trustedIssuers',
  'permittedActions',
  'permittedResources',
  'bindingFormats',
  'expectedOrigin',
  'methods',
  'clientCredential',
  'maximumLifetimeMs',
  'maximumClockSkewMs',
  'statusPolicy',
  'listen',
]);

const LIMITS = Object.freeze({
  maximumIssuers: 8,
  maximumKeysPerIssuer: 8,
  maximumOrganizations: 16,
  maximumAllowListEntries: 64,
  minimumCredentialLength: 16,
  maximumCredentialLength: 4_096,
});

/**
 * Header names the client credential may not use: everything the Host's
 * Generic HTTP adapter owns or refuses, plus the presentation header.
 */
const RESERVED_CREDENTIAL_HEADERS: readonly string[] = Object.freeze([
  'host',
  'content-length',
  'content-type',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'upgrade',
  'expect',
  'cookie',
  'set-cookie',
  'http2-settings',
  'forwarded',
  'via',
  EXECUTION_CAPABILITY_PRESENTATION_HEADER,
]);

const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const TOKEN68 = /^[A-Za-z0-9\-._~+/]+=*$/;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ORIGIN = /^https:\/\/([a-z0-9.-]{1,253})(?::([1-9][0-9]{0,4}))?$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SPKI_PEM = /^-----BEGIN PUBLIC KEY-----\r?\n(?:[A-Za-z0-9+/=]{1,76}\r?\n)+-----END PUBLIC KEY-----\r?\n?$/;

function fail(code: ReferenceExecutorConfigurationErrorCode, message: string): never {
  throw new ReferenceExecutorConfigurationError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/** Exactly `fields`, as own enumerable data properties: an unknown key, a missing key or an accessor is refused. */
function closed(value: unknown, fields: readonly string[], what: string): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) return fail('CONFIGURATION_MALFORMED', `${what} must be a JSON object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !fields.includes(key)) fail('CONFIGURATION_UNKNOWN_KEY', `${what} has a field this contract does not declare.`);
  }
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) fail('CONFIGURATION_MISSING_FIELD', `${what} is missing '${field}'.`);
    if (!('value' in descriptor) || descriptor.enumerable !== true) fail('CONFIGURATION_MALFORMED', `${what} field '${field}' is not plain data.`);
    out[field] = descriptor.value;
  }
  return out;
}

/** One exact identity: a G-02A identifier that cannot be read as a pattern. */
function identity(value: unknown, what: string): string {
  if (!isExecutionCapabilityIdentifier(value) || value.includes('*')) return fail('IDENTITY_INVALID', `${what} must be one exact identifier; a wildcard or pattern is refused.`);
  return value;
}

function identityList(value: unknown, what: string, maximum: number, code: ReferenceExecutorConfigurationErrorCode): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return fail(code, `${what} must list from 1 to ${maximum} entries.`);
  const entries = value.map((entry: unknown) => identity(entry, `Each entry of ${what}`));
  if (new Set(entries).size !== entries.length) fail(code, `${what} lists an entry twice.`);
  return Object.freeze(entries);
}

function integer(value: unknown, minimum: number, maximum: number, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return fail('LIMIT_INVALID', `${what} must be an integer from ${minimum} to ${maximum}.`);
  return value;
}

function parseOrigin(value: unknown): ReferenceExecutorOrigin {
  const invalid = (reason: string): never => fail('ORIGIN_INVALID', `expectedOrigin is not an exact https origin: ${reason}.`);
  if (typeof value !== 'string') return invalid('it must be a string');
  const match = ORIGIN.exec(value);
  if (match === null) return invalid('only https, a lower-case DNS hostname and an optional port without leading zeros are allowed');
  const hostname = match[1] ?? '';
  const labels = hostname.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label)) || /^[0-9]+$/.test(labels[labels.length - 1] ?? '')) return invalid('the hostname is not a fully qualified DNS name');
  const portText = match[2];
  const port = portText === undefined ? 443 : Number(portText);
  if (port < 1 || port > 65_535) return invalid('the port is out of range');
  if (portText === '443') return invalid('the default port is written without a port');
  return Object.freeze({ scheme: 'https' as const, hostname, port, authority: port === 443 ? hostname : `${hostname}:${String(port)}` });
}

function parseIssuers(value: unknown): readonly ExecutionCapabilityTrustedIssuer[] {
  if (!Array.isArray(value) || value.length === 0) return fail('TRUST_REGISTRY_EMPTY', 'trustedIssuers must pin at least one issuer.');
  if (value.length > LIMITS.maximumIssuers) fail('LIMIT_INVALID', `trustedIssuers may pin at most ${LIMITS.maximumIssuers} issuers.`);
  const issuers = new Set<string>();
  const keyIds = new Set<string>();
  const materials = new Set<string>();
  return Object.freeze(
    value.map((entry: unknown) => {
      const fields = closed(entry, ['issuer', 'keys'], 'A trusted issuer');
      const issuer = identity(fields['issuer'], 'A trusted issuer id');
      if (issuers.has(issuer)) fail('KEY_OWNERSHIP_DUPLICATE', 'An issuer is pinned twice.');
      issuers.add(issuer);
      const keys = fields['keys'];
      if (!Array.isArray(keys) || keys.length === 0) return fail('TRUST_REGISTRY_EMPTY', 'A trusted issuer must pin at least one key.');
      if (keys.length > LIMITS.maximumKeysPerIssuer) fail('LIMIT_INVALID', `A trusted issuer may pin at most ${LIMITS.maximumKeysPerIssuer} keys.`);
      const pinned = keys.map((key: unknown) => {
        const keyFields = closed(key, ['keyId', 'algorithm', 'publicKeyPem'], 'A pinned key');
        const keyId = identity(keyFields['keyId'], 'A pinned key id');
        if (keyIds.has(keyId)) fail('KEY_OWNERSHIP_DUPLICATE', 'A key id is pinned twice; a key id names one key of one issuer.');
        keyIds.add(keyId);
        if (keyFields['algorithm'] !== 'ed25519-v1') fail('ALGORITHM_UNTRUSTED', 'A pinned key must be ed25519-v1; no other algorithm is trusted.');
        const pem = keyFields['publicKeyPem'];
        if (typeof pem !== 'string' || !SPKI_PEM.test(pem)) return fail('PUBLIC_KEY_INVALID', 'A pinned key must be one SPKI PEM public key block.');
        let material: string;
        try {
          material = createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
        } catch {
          return fail('PUBLIC_KEY_INVALID', 'A pinned key could not be parsed as a public key.');
        }
        if (materials.has(material)) fail('KEY_OWNERSHIP_DUPLICATE', 'The same public key material is pinned twice.');
        materials.add(material);
        return Object.freeze({ keyId, algorithm: 'ed25519-v1' as const, publicKeyPem: pem });
      });
      try {
        // CORE-02's own registry rules, unchanged: public SPKI only, key type matches the algorithm.
        createAuthoritySignatureRegistry(pinned);
      } catch {
        fail('PUBLIC_KEY_INVALID', 'A pinned key is not an Ed25519 public key.');
      }
      return Object.freeze({ issuer, keys: Object.freeze(pinned) });
    }),
  );
}

function parseCredential(value: unknown, environment: Readonly<Record<string, string | undefined>>): ReferenceExecutorCredential {
  if (!isPlainObject(value)) return fail('CREDENTIAL_INVALID', 'clientCredential must be a JSON object.');
  const read = (name: unknown): string => {
    if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) return fail('CREDENTIAL_INVALID', 'The credential must name an upper-case environment variable.');
    const secret = environment[name];
    if (typeof secret !== 'string' || secret.length < LIMITS.minimumCredentialLength || secret.length > LIMITS.maximumCredentialLength) {
      return fail('CREDENTIAL_INVALID', `The credential environment variable must hold ${LIMITS.minimumCredentialLength} to ${LIMITS.maximumCredentialLength} characters.`);
    }
    return secret;
  };
  const digest = (expected: string): string => createHash('sha256').update(expected, 'utf8').digest('hex');
  if (value['kind'] === 'bearer') {
    const fields = closed(value, ['kind', 'tokenEnv'], 'A bearer clientCredential');
    const token = read(fields['tokenEnv']);
    if (!TOKEN68.test(token)) fail('CREDENTIAL_INVALID', 'A bearer token must be a token68 string.');
    return Object.freeze({ header: 'authorization', expectedDigest: digest(`Bearer ${token}`) });
  }
  if (value['kind'] === 'header') {
    const fields = closed(value, ['kind', 'name', 'valueEnv'], 'A header clientCredential');
    const name = fields['name'];
    if (typeof name !== 'string' || name.length > 128 || !HTTP_TOKEN.test(name)) return fail('CREDENTIAL_INVALID', 'A credential header name must be one lower-case HTTP token.');
    if (name === 'authorization' || name.startsWith('proxy-') || isRefusedByAdmission(name) || RESERVED_CREDENTIAL_HEADERS.includes(name)) {
      fail('CREDENTIAL_INVALID', 'The credential header name is reserved; use the bearer kind for Authorization.');
    }
    const secret = read(fields['valueEnv']);
    if (!VISIBLE_ASCII.test(secret)) fail('CREDENTIAL_INVALID', 'A header credential value must be visible ASCII with no space.');
    return Object.freeze({ header: name, expectedDigest: digest(secret) });
  }
  return fail('CREDENTIAL_INVALID', "clientCredential kind must be 'bearer' or 'header'.");
}

/**
 * Validates `raw` (the parsed JSON document) against the closed contract and
 * reads the credential from `environment`. Throws
 * `ReferenceExecutorConfigurationError` on the first defect.
 */
export function parseReferenceExecutorConfiguration(raw: unknown, environment: Readonly<Record<string, string | undefined>>): ReferenceExecutorConfiguration {
  const fields = closed(raw, TOP_LEVEL_FIELDS, 'The reference executor configuration');
  if (fields['format'] !== REFERENCE_EXECUTOR_CONFIGURATION_FORMAT) fail('CONFIGURATION_FORMAT_UNSUPPORTED', `format must be '${REFERENCE_EXECUTOR_CONFIGURATION_FORMAT}'.`);
  if (fields['environment'] !== REFERENCE_EXECUTOR_ENVIRONMENT) fail('ENVIRONMENT_UNSUPPORTED', `The reference executor runs only in '${REFERENCE_EXECUTOR_ENVIRONMENT}'.`);

  const executorId = identity(fields['executorId'], 'executorId');
  const audience = identity(fields['audience'], 'audience');
  const organizationIds = identityList(fields['organizationIds'], 'organizationIds', LIMITS.maximumOrganizations, 'IDENTITY_INVALID');
  const trustDomain = identity(fields['trustDomain'], 'trustDomain');
  const trustedIssuers = parseIssuers(fields['trustedIssuers']);

  // An executor's own identities are never also a trusted issuer, and its audience is not one of the organizations it serves.
  const own = new Set([executorId, audience, trustDomain, ...organizationIds]);
  if (trustedIssuers.some((entry) => own.has(entry.issuer))) fail('IDENTITY_RELATIONSHIP_INVALID', 'A trusted issuer id equals one of the executor’s own identities.');
  if (organizationIds.includes(audience) || organizationIds.includes(trustDomain)) fail('IDENTITY_RELATIONSHIP_INVALID', 'An organization id equals the audience or the trust domain.');

  const permittedActions = identityList(fields['permittedActions'], 'permittedActions', LIMITS.maximumAllowListEntries, 'ALLOW_LIST_INVALID');
  const permittedResources = identityList(fields['permittedResources'], 'permittedResources', LIMITS.maximumAllowListEntries, 'ALLOW_LIST_INVALID');

  const bindingFormats = fields['bindingFormats'];
  if (!Array.isArray(bindingFormats) || bindingFormats.length === 0 || !bindingFormats.every((format: unknown) => format === REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT) || bindingFormats.length !== 1) {
    fail('BINDING_FORMAT_UNRECOGNIZED', `bindingFormats must be exactly ['${REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT}'].`);
  }

  const origin = parseOrigin(fields['expectedOrigin']);

  const methods = fields['methods'];
  if (!Array.isArray(methods) || methods.length === 0 || !methods.every((method: unknown) => (REFERENCE_EXECUTOR_METHODS as readonly unknown[]).includes(method)) || new Set(methods).size !== methods.length) {
    fail('METHOD_INVALID', 'methods must list distinct entries of POST, PUT, PATCH and DELETE.');
  }

  const credential = parseCredential(fields['clientCredential'], environment);
  const maximumLifetimeMs = integer(fields['maximumLifetimeMs'], 1, EXECUTION_CAPABILITY_LIMITS.maximumLifetimeMs, 'maximumLifetimeMs');
  const maximumClockSkewMs = integer(fields['maximumClockSkewMs'], 0, EXECUTION_CAPABILITY_LIMITS.maximumClockSkewMs, 'maximumClockSkewMs');
  if (!(REFERENCE_EXECUTOR_STATUS_POLICIES as readonly unknown[]).includes(fields['statusPolicy'])) {
    fail('STATUS_POLICY_UNSUPPORTED', "statusPolicy must be 'offline-only': no status mechanism exists before G-02D.");
  }

  const listen = closed(fields['listen'], ['host', 'port'], 'listen');
  const host = listen['host'];
  if (host !== '127.0.0.1' && host !== '::1') fail('RUNTIME_UNSAFE', 'The reference executor listens on a loopback address only.');
  const port = integer(listen['port'], 0, 65_535, 'listen.port');

  return Object.freeze({
    executorId,
    audience,
    organizationIds,
    trustDomain,
    trustedIssuers,
    permittedActions,
    permittedResources,
    bindingFormats: Object.freeze([REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT]),
    origin,
    methods: Object.freeze([...(methods as ReferenceExecutorMethod[])]),
    credential,
    maximumLifetimeMs,
    maximumClockSkewMs,
    statusPolicy: 'offline-only' as const,
    listen: Object.freeze({ host: host as '127.0.0.1' | '::1', port }),
  });
}
