import { createHash, createPublicKey } from 'node:crypto';
import { dirname, isAbsolute, normalize, sep } from 'node:path';

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
 * ## Mode (G-02C1B)
 *
 * `mode` is `verification-only` unless the document says
 * `synthetic-execution`, and an absent `mode` is `verification-only`: every
 * G-02C1A document keeps its meaning. `synthetic-execution` requires the
 * `syntheticExecution` section — an existing G-02A consumption ledger, a
 * dedicated output directory, the one synthetic effect and its `synthetic.*`
 * actions — and that section is refused in every other mode, so no field can
 * enable an effect on its own. There is no receipt key or receipt ledger here
 * (G-02C1C).
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
  'MODE_UNSUPPORTED',
  'MODE_INCONSISTENT',
  'SYNTHETIC_EXECUTION_INVALID',
  'FAULT_INJECTION_INVALID',
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

export const REFERENCE_EXECUTOR_MODES = Object.freeze(['verification-only', 'synthetic-execution'] as const);
export type ReferenceExecutorMode = (typeof REFERENCE_EXECUTOR_MODES)[number];

/** The one effect a reference executor can perform: a local record that a synthetic release was applied to a synthetic target. Never a deployment. */
export const SYNTHETIC_DEPLOYMENT_EFFECT = 'frontera.synthetic-deployment-record.v1';
/** Every action the synthetic effect performs is named as synthetic. */
export const SYNTHETIC_ACTION_PREFIX = 'synthetic.';

/** Where CI may crash the process on purpose (G-02C1B crash qualification): each point lies on the execution path, in this order. */
export const REFERENCE_EXECUTOR_FAULT_POINTS = Object.freeze(['before-claim', 'after-claim', 'after-expiry-check', 'during-effect', 'after-effect', 'after-outcome'] as const);
export type ReferenceExecutorFaultPoint = (typeof REFERENCE_EXECUTOR_FAULT_POINTS)[number];

export interface ReferenceExecutorSyntheticExecution {
  readonly effect: typeof SYNTHETIC_DEPLOYMENT_EFFECT;
  /** An existing G-02A ledger file, pinned to this executor's audience. Never created by the executor. */
  readonly consumptionLedgerPath: string;
  /** An existing directory dedicated to synthetic records, fixed at boot. Nothing from a request names a path. */
  readonly outputDirectory: string;
  /** The `synthetic.*` actions the effect performs: a subset of `permittedActions`. Any other permitted action is verified and never performed. */
  readonly syntheticActions: readonly string[];
}

/** A validated, deep-frozen configuration. */
export interface ReferenceExecutorConfiguration {
  readonly mode: ReferenceExecutorMode;
  /** Present exactly in `synthetic-execution` mode. */
  readonly syntheticExecution: ReferenceExecutorSyntheticExecution | null;
  /** CI crash injection: present only when the document asks for it, only in `synthetic-execution` mode. */
  readonly faultInjection: { readonly crashAt: ReferenceExecutorFaultPoint } | null;
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
/** Optional top-level fields: absent means verification-only, no synthetic section, no fault injection. */
const OPTIONAL_TOP_LEVEL_FIELDS = Object.freeze(['mode', 'syntheticExecution', 'faultInjection']);

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
function closed(value: unknown, fields: readonly string[], what: string, optional: readonly string[] = []): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) return fail('CONFIGURATION_MALFORMED', `${what} must be a JSON object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !(fields.includes(key) || optional.includes(key))) fail('CONFIGURATION_UNKNOWN_KEY', `${what} has a field this contract does not declare.`);
  }
  const out: Record<string, unknown> = {};
  for (const field of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor === undefined) continue;
    if (!('value' in descriptor) || descriptor.enumerable !== true) fail('CONFIGURATION_MALFORMED', `${what} field '${field}' is not plain data.`);
    out[field] = descriptor.value;
  }
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
  const fields = closed(raw, TOP_LEVEL_FIELDS, 'The reference executor configuration', OPTIONAL_TOP_LEVEL_FIELDS);
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

  const mode = parseMode(fields['mode']);
  const syntheticExecution = mode === 'synthetic-execution' ? parseSyntheticExecution(fields['syntheticExecution'], permittedActions) : null;
  if (mode !== 'synthetic-execution' && fields['syntheticExecution'] !== undefined) fail('MODE_INCONSISTENT', 'syntheticExecution is accepted only in synthetic-execution mode.');
  if (mode !== 'synthetic-execution' && fields['faultInjection'] !== undefined) fail('MODE_INCONSISTENT', 'faultInjection is accepted only in synthetic-execution mode.');
  const faultInjection = fields['faultInjection'] === undefined ? null : parseFaultInjection(fields['faultInjection']);

  return Object.freeze({
    mode,
    syntheticExecution,
    faultInjection,
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

function parseMode(value: unknown): ReferenceExecutorMode {
  if (value === undefined) return 'verification-only';
  if (value !== 'verification-only' && value !== 'synthetic-execution') return fail('MODE_UNSUPPORTED', "mode must be 'verification-only' or 'synthetic-execution'.");
  return value;
}

/** An absolute, already-normalized local path with no trailing separator: one spelling, never resolved against a working directory. */
function absolutePath(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_024 || value.includes('\0') || !isAbsolute(value) || normalize(value) !== value || (value.length > 1 && value.endsWith(sep))) {
    return fail('SYNTHETIC_EXECUTION_INVALID', `${what} must be an absolute, normalized path.`);
  }
  return value;
}

function parseSyntheticExecution(value: unknown, permittedActions: readonly string[]): ReferenceExecutorSyntheticExecution {
  if (value === undefined) return fail('MODE_INCONSISTENT', 'synthetic-execution mode requires the syntheticExecution section.');
  const fields = closed(value, ['effect', 'consumptionLedgerPath', 'outputDirectory', 'syntheticActions'], 'syntheticExecution');
  if (fields['effect'] !== SYNTHETIC_DEPLOYMENT_EFFECT) fail('SYNTHETIC_EXECUTION_INVALID', `The only effect is '${SYNTHETIC_DEPLOYMENT_EFFECT}'.`);
  const consumptionLedgerPath = absolutePath(fields['consumptionLedgerPath'], 'consumptionLedgerPath');
  const outputDirectory = absolutePath(fields['outputDirectory'], 'outputDirectory');
  // The ledger and the records are separate: a record can never land on, beside or above the ledger.
  const ledgerDirectory = dirname(consumptionLedgerPath);
  const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  if (inside(consumptionLedgerPath, outputDirectory) || inside(outputDirectory, ledgerDirectory) || inside(ledgerDirectory, outputDirectory)) {
    fail('SYNTHETIC_EXECUTION_INVALID', 'The output directory must be separate from the consumption ledger and its directory.');
  }
  const syntheticActions = identityList(fields['syntheticActions'], 'syntheticActions', LIMITS.maximumAllowListEntries, 'SYNTHETIC_EXECUTION_INVALID');
  for (const action of syntheticActions) {
    if (!action.startsWith(SYNTHETIC_ACTION_PREFIX) || action.length === SYNTHETIC_ACTION_PREFIX.length) fail('SYNTHETIC_EXECUTION_INVALID', `Every synthetic action is named '${SYNTHETIC_ACTION_PREFIX}…'.`);
    if (!permittedActions.includes(action)) fail('SYNTHETIC_EXECUTION_INVALID', 'Every synthetic action must also be a permitted action.');
  }
  return Object.freeze({ effect: SYNTHETIC_DEPLOYMENT_EFFECT, consumptionLedgerPath, outputDirectory, syntheticActions });
}

function parseFaultInjection(value: unknown): { readonly crashAt: ReferenceExecutorFaultPoint } {
  const fields = closed(value, ['crashAt'], 'faultInjection');
  const crashAt = REFERENCE_EXECUTOR_FAULT_POINTS.find((point) => point === fields['crashAt']);
  if (crashAt === undefined) return fail('FAULT_INJECTION_INVALID', 'faultInjection.crashAt must name one fault point.');
  return Object.freeze({ crashAt });
}
