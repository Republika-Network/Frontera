import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUTHORITY_SIGNING_DOMAINS } from '../authority-authenticity/index.js';
import { executionCapabilitySigningBytes, serializeExecutionCapability } from '../execution-capability/index.js';
import {
  EXECUTION_CAPABILITY_PRESENTATION_FORMAT,
  EXECUTION_CAPABILITY_PRESENTATION_HEADER,
  decodeExecutionCapabilityPresentation,
  encodeExecutionCapabilityPresentation,
  type ExecutionCapabilityPresentationFailure,
} from '../execution-capability-presentation/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import {
  REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT,
  ReferenceExecutorConfigurationError,
  createReferenceExecutorVerificationPipeline,
  parseReferenceExecutorConfiguration,
  referenceExecutorStatusOf,
  type ReferenceExecutorAssessment,
  type ReferenceExecutorConfigurationErrorCode,
} from '../reference-executor/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import {
  ACTION,
  AUDIENCE,
  BEARER,
  BEARER_ENV,
  EXECUTOR_ENVIRONMENT,
  HOSTNAME,
  ISSUER,
  ISSUER_KEY,
  ISSUER_ROTATED_KEY,
  ORGANIZATION,
  OTHER_ISSUER,
  OTHER_ISSUER_KEY,
  RESOURCE,
  TRUST_DOMAIN,
  UNPINNED_KEY,
  addRawHeader,
  capabilityFor,
  dropRawHeader,
  executorConfiguration,
  hostVector,
  observedWith,
  pin,
  presentationFor,
  rawPresentation,
  setRawHeader,
  signatureOver,
} from './g02c1a-reference-executor-fixture.js';

/**
 * G-02C1A, in process: the presentation codec, the closed trust configuration
 * and the verification pipeline. The separate-process suite
 * (`g02c1a-reference-executor-process.test.ts`) runs the same pipeline behind
 * real HTTP/1.1 bytes.
 */

const BODY = {
  kind: 'json-object',
  fields: {
    subject: { kind: 'source', source: 'subject' },
    amount: { kind: 'source', source: 'amount.value' },
    replicas: { kind: 'parameter', dimension: 'replicaCount' },
  },
};

const WITH_BODY = hostVector('POST with body and headers', {
  body: BODY,
  query: { strategy: { kind: 'parameter', dimension: 'strategy' } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' }, 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
});
const NO_BODY = hostVector('POST without body');
const DELETE = hostVector('DELETE without body', { method: 'DELETE' });

function envelopeOf(text: string, signature: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT, capability: text, format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature, ...overrides };
}

function validEnvelope(): { readonly text: string; readonly signature: Record<string, unknown> } {
  const capability = capabilityFor(WITH_BODY.digest);
  return { text: serializeExecutionCapability(capability), signature: signatureOver(executionCapabilitySigningBytes(capability), ISSUER_KEY) };
}

const base64url = (text: string | Buffer): string => (typeof text === 'string' ? Buffer.from(text, 'utf8') : text).toString('base64url');

describe('G-02C1A — the presentation envelope (frontera.execution-capability-presentation.v1)', () => {
  it('round-trips: exactly the capability text, the CORE-02 envelope and the binding format — four fields, nothing else', () => {
    const capability = capabilityFor(WITH_BODY.digest);
    const encoded = presentationFor(capability);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    const decoded = decodeExecutionCapabilityPresentation(encoded);
    assert.ok(decoded.ok);
    assert.equal(decoded.presentation.capability, serializeExecutionCapability(capability));
    assert.equal(decoded.presentation.bindingFormat, GENERIC_HTTP_REQUEST_BINDING_FORMAT);
    assert.deepEqual(Object.keys(decoded.presentation.signature).sort(), ['algorithm', 'artifactVersion', 'keyId', 'signature']);
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(envelope), ['bindingFormat', 'capability', 'format', 'signature']);
    assert.equal(envelope['format'], EXECUTION_CAPABILITY_PRESENTATION_FORMAT);
    assert.equal(EXECUTION_CAPABILITY_PRESENTATION_HEADER, 'frontera-execution-capability');
  });

  it('carries no grant, grant nonce, policy, approval, credential, key or store detail', () => {
    const text = Buffer.from(presentationFor(capabilityFor(WITH_BODY.digest)), 'base64url').toString('utf8');
    for (const forbidden of ['nonce', 'boundedGrantId', 'grantStoreId', 'grantDigest', 'policy', 'approval', 'PRIVATE KEY', 'BEGIN', BEARER, '.sqlite', 'evidence']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it('refuses every other spelling, never normalizing one', () => {
    const { text, signature } = validEnvelope();
    const canonical = canonicalSerialize(envelopeOf(text, signature));
    const cases: readonly (readonly [string, unknown, ExecutionCapabilityPresentationFailure])[] = [
      ['absent', undefined, 'PRESENTATION_MISSING'],
      ['empty', '', 'PRESENTATION_MISSING'],
      ['not a string', 42, 'PRESENTATION_MISSING'],
      ['too large', 'A'.repeat(8_193), 'PRESENTATION_TOO_LARGE'],
      ['padded', `${base64url(canonical)}==`, 'PRESENTATION_ENCODING_INVALID'],
      ['a character of the standard base64 alphabet', `${base64url(canonical).slice(0, -1)}+`, 'PRESENTATION_ENCODING_INVALID'],
      ['impossible length', `${base64url(canonical)}A`.slice(0, 4 * Math.floor(base64url(canonical).length / 4) + 1), 'PRESENTATION_ENCODING_INVALID'],
      ['stray trailing bits', 'QR', 'PRESENTATION_ENCODING_INVALID'],
      ['not UTF-8', base64url(Buffer.from([0x7b, 0xff, 0xfe, 0x7d])), 'PRESENTATION_NOT_UTF8'],
      ['not JSON', base64url('not json'), 'PRESENTATION_MALFORMED'],
      ['a JSON array', base64url('[]'), 'PRESENTATION_MALFORMED'],
      ['an extra field', rawPresentation(envelopeOf(text, signature, { grant: 'x' })), 'PRESENTATION_MALFORMED'],
      ['a missing field', rawPresentation({ capability: text, format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature }), 'PRESENTATION_MALFORMED'],
      ['whitespace', base64url(JSON.stringify(JSON.parse(canonical), null, 1)), 'PRESENTATION_NONCANONICAL'],
      ['reordered keys', base64url(JSON.stringify({ format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT, capability: text, signature: JSON.parse(canonicalSerialize(signature)) as unknown })), 'PRESENTATION_NONCANONICAL'],
      ['a duplicated key', base64url(`{"bindingFormat":"x",${canonical.slice(1)}`), 'PRESENTATION_NONCANONICAL'],
      ['an escape where a character would do', base64url(canonical.replace('"format":"frontera', '"format":"\\u0066rontera')), 'PRESENTATION_NONCANONICAL'],
      ['another version', rawPresentation(envelopeOf(text, signature, { format: 'frontera.execution-capability-presentation.v2' })), 'PRESENTATION_FORMAT_UNSUPPORTED'],
      ['algorithm substitution', rawPresentation(envelopeOf(text, { ...signature, algorithm: 'rsa-pss-sha256' })), 'PRESENTATION_ALGORITHM_UNSUPPORTED'],
      ['a bare algorithm name', rawPresentation(envelopeOf(text, { ...signature, algorithm: 'ed25519' })), 'PRESENTATION_ALGORITHM_UNSUPPORTED'],
      ['another artifact version', rawPresentation(envelopeOf(text, { ...signature, artifactVersion: 'aoc.authority-artifact.v2' })), 'PRESENTATION_SIGNATURE_MALFORMED'],
      ['a truncated signature', rawPresentation(envelopeOf(text, { ...signature, signature: String(signature['signature']).slice(0, 80) })), 'PRESENTATION_SIGNATURE_MALFORMED'],
      ['a signature outside base64url', rawPresentation(envelopeOf(text, { ...signature, signature: `${String(signature['signature']).slice(0, 85)}+` })), 'PRESENTATION_SIGNATURE_MALFORMED'],
      ['an empty key id', rawPresentation(envelopeOf(text, { ...signature, keyId: '' })), 'PRESENTATION_SIGNATURE_MALFORMED'],
      ['an extra signature field', rawPresentation(envelopeOf(text, { ...signature, keyType: 'ed25519' })), 'PRESENTATION_SIGNATURE_MALFORMED'],
      ['a non-canonical capability', rawPresentation(envelopeOf(`{ ${text.slice(1)}`, signature)), 'PRESENTATION_CAPABILITY_INVALID'],
      ['an extra capability field', rawPresentation(envelopeOf(`{"aaa":"x",${text.slice(1)}`, signature)), 'PRESENTATION_CAPABILITY_INVALID'],
      ['a binding format that is not the signed one', rawPresentation(envelopeOf(text, signature, { bindingFormat: 'frontera.batch-job-binding.v1' })), 'PRESENTATION_BINDING_FORMAT_MISMATCH'],
    ];
    for (const [name, value, failure] of cases) {
      const decoded = decodeExecutionCapabilityPresentation(value);
      assert.equal(decoded.ok, false, name);
      if (!decoded.ok) assert.equal(decoded.failure, failure, name);
    }
    assert.ok(decodeExecutionCapabilityPresentation(base64url(canonical)).ok, 'the canonical spelling itself decodes');
  });

  it('the encoder refuses what the decoder refuses: it can only produce a decodable value', () => {
    const { text, signature } = validEnvelope();
    assert.throws(() => encodeExecutionCapabilityPresentation({ capability: text, signature: signature as never, bindingFormat: 'frontera.batch-job-binding.v1' }), TypeError);
    assert.throws(() => encodeExecutionCapabilityPresentation({ capability: `{ ${text.slice(1)}`, signature: signature as never, bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT }), TypeError);
  });
});

// ── The closed configuration ────────────────────────────────────────────────

function refusedCode(raw: unknown, environment: Readonly<Record<string, string | undefined>> = EXECUTOR_ENVIRONMENT): ReferenceExecutorConfigurationErrorCode {
  try {
    parseReferenceExecutorConfiguration(raw, environment);
  } catch (error) {
    assert.ok(error instanceof ReferenceExecutorConfigurationError, String(error));
    for (const secret of [BEARER, 'BEGIN', 'shortsecret', 'Secret With Spaces 0123456789']) assert.equal(error.message.includes(secret), false, `the message echoes nothing: ${error.message}`);
    return error.code;
  }
  return assert.fail('the configuration was accepted');
}

describe('G-02C1A — the closed trust configuration', () => {
  it('a valid configuration is deep-frozen, keeps only the credential digest, and holds public material only', () => {
    const configuration = parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT);
    for (const value of [configuration, configuration.trustedIssuers, configuration.trustedIssuers[0], configuration.trustedIssuers[0]?.keys, configuration.trustedIssuers[0]?.keys[0], configuration.organizationIds, configuration.permittedActions, configuration.origin, configuration.credential, configuration.listen]) {
      assert.ok(value !== undefined && Object.isFrozen(value));
    }
    const shown = JSON.stringify(configuration);
    assert.equal(shown.includes(BEARER), false, 'the credential value is not retained');
    assert.equal(/PRIVATE KEY/.test(shown), false);
    assert.deepEqual(configuration.origin, { scheme: 'https', hostname: HOSTNAME, port: 443, authority: HOSTNAME });
    assert.equal(configuration.credential.header, 'authorization');
    assert.deepEqual(configuration.bindingFormats, [REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT]);
    const port = parseReferenceExecutorConfiguration(executorConfiguration({ expectedOrigin: `https://${HOSTNAME}:8443` }), EXECUTOR_ENVIRONMENT);
    assert.equal(port.origin.authority, `${HOSTNAME}:8443`);
  });

  it('refuses every defect at boot, by name, echoing no value', () => {
    const issuers = (executorConfiguration()['trustedIssuers'] as Record<string, unknown>[]).map((entry) => ({ ...entry }));
    const x25519 = generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privatePem = ISSUER_KEY.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const withAccessor = executorConfiguration();
    Object.defineProperty(withAccessor, 'audience', { get: () => AUDIENCE, enumerable: true });
    const cases: readonly (readonly [string, unknown, ReferenceExecutorConfigurationErrorCode, Readonly<Record<string, string | undefined>>?])[] = [
      ['not an object', 'config', 'CONFIGURATION_MALFORMED'],
      ['an unknown key', executorConfiguration({ receiptKey: 'x' }), 'CONFIGURATION_UNKNOWN_KEY'],
      ['a missing field', (() => { const raw = executorConfiguration(); delete raw['audience']; return raw; })(), 'CONFIGURATION_MISSING_FIELD'],
      ['an accessor', withAccessor, 'CONFIGURATION_MALFORMED'],
      ['another format', executorConfiguration({ format: 'frontera.reference-executor-configuration.v2' }), 'CONFIGURATION_FORMAT_UNSUPPORTED'],
      ['a production environment', executorConfiguration({ environment: 'production' }), 'ENVIRONMENT_UNSUPPORTED'],
      ['a wildcard audience', executorConfiguration({ audience: '*' }), 'IDENTITY_INVALID'],
      ['a pattern audience', executorConfiguration({ audience: 'executor-*' }), 'IDENTITY_INVALID'],
      ['a wildcard organization', executorConfiguration({ organizationIds: ['*'] }), 'IDENTITY_INVALID'],
      ['a wildcard issuer', executorConfiguration({ trustedIssuers: [{ issuer: '*', keys: [pin(ISSUER_KEY)] }] }), 'IDENTITY_INVALID'],
      ['a wildcard action', executorConfiguration({ permittedActions: ['*'] }), 'IDENTITY_INVALID'],
      ['an untrimmed trust domain', executorConfiguration({ trustDomain: ` ${TRUST_DOMAIN}` }), 'IDENTITY_INVALID'],
      ['no organization', executorConfiguration({ organizationIds: [] }), 'IDENTITY_INVALID'],
      ['a repeated organization', executorConfiguration({ organizationIds: [ORGANIZATION, ORGANIZATION] }), 'IDENTITY_INVALID'],
      ['an empty trust registry', executorConfiguration({ trustedIssuers: [] }), 'TRUST_REGISTRY_EMPTY'],
      ['an issuer with no key', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [] }] }), 'TRUST_REGISTRY_EMPTY'],
      ['an issuer pinned twice', executorConfiguration({ trustedIssuers: [issuers[0], issuers[0]] }), 'KEY_OWNERSHIP_DUPLICATE'],
      ['one key id for two issuers', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [pin(ISSUER_KEY)] }, { issuer: OTHER_ISSUER, keys: [{ ...pin(OTHER_ISSUER_KEY), keyId: ISSUER_KEY.keyId }] }] }), 'KEY_OWNERSHIP_DUPLICATE'],
      ['one key material under two ids', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [pin(ISSUER_KEY)] }, { issuer: OTHER_ISSUER, keys: [{ ...pin(ISSUER_KEY), keyId: 'g02c1a-copy' }] }] }), 'KEY_OWNERSHIP_DUPLICATE'],
      ['an untrusted algorithm', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [{ ...pin(ISSUER_KEY), algorithm: 'rsa-pss-sha256' }] }] }), 'ALGORITHM_UNTRUSTED'],
      ['a PEM that is not a key', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [{ ...pin(ISSUER_KEY), publicKeyPem: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n' }] }] }), 'PUBLIC_KEY_INVALID'],
      ['a private key', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [{ ...pin(ISSUER_KEY), publicKeyPem: privatePem }] }] }), 'PUBLIC_KEY_INVALID'],
      ['a key of another type', executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [{ ...pin(ISSUER_KEY), publicKeyPem: x25519 }] }] }), 'PUBLIC_KEY_INVALID'],
      ['an issuer that is the audience', executorConfiguration({ trustedIssuers: [{ issuer: AUDIENCE, keys: [pin(ISSUER_KEY)] }] }), 'IDENTITY_RELATIONSHIP_INVALID'],
      ['an organization that is the audience', executorConfiguration({ organizationIds: [AUDIENCE] }), 'IDENTITY_RELATIONSHIP_INVALID'],
      ['no action', executorConfiguration({ permittedActions: [] }), 'ALLOW_LIST_INVALID'],
      ['a repeated resource', executorConfiguration({ permittedResources: [RESOURCE, RESOURCE] }), 'ALLOW_LIST_INVALID'],
      ['an unrecognized binding format', executorConfiguration({ bindingFormats: ['frontera.batch-job-binding.v1'] }), 'BINDING_FORMAT_UNRECOGNIZED'],
      ['no binding format', executorConfiguration({ bindingFormats: [] }), 'BINDING_FORMAT_UNRECOGNIZED'],
      ['an http origin', executorConfiguration({ expectedOrigin: `http://${HOSTNAME}` }), 'ORIGIN_INVALID'],
      ['an origin with a path', executorConfiguration({ expectedOrigin: `https://${HOSTNAME}/v1` }), 'ORIGIN_INVALID'],
      ['an explicit default port', executorConfiguration({ expectedOrigin: `https://${HOSTNAME}:443` }), 'ORIGIN_INVALID'],
      ['a port with a leading zero', executorConfiguration({ expectedOrigin: `https://${HOSTNAME}:08443` }), 'ORIGIN_INVALID'],
      ['an upper-case hostname', executorConfiguration({ expectedOrigin: 'https://Gateway.Executor.Example' }), 'ORIGIN_INVALID'],
      ['an IP origin', executorConfiguration({ expectedOrigin: 'https://127.0.0.1' }), 'ORIGIN_INVALID'],
      ['a single-label origin', executorConfiguration({ expectedOrigin: 'https://localhost' }), 'ORIGIN_INVALID'],
      ['a port out of range', executorConfiguration({ expectedOrigin: `https://${HOSTNAME}:70000` }), 'ORIGIN_INVALID'],
      ['GET', executorConfiguration({ methods: ['GET'] }), 'METHOD_INVALID'],
      ['no method', executorConfiguration({ methods: [] }), 'METHOD_INVALID'],
      ['an unknown credential kind', executorConfiguration({ clientCredential: { kind: 'basic', tokenEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['a missing credential variable', executorConfiguration(), 'CREDENTIAL_INVALID', {}],
      ['a short credential', executorConfiguration(), 'CREDENTIAL_INVALID', { [BEARER_ENV]: 'shortsecret' }],
      ['a credential that is not token68', executorConfiguration(), 'CREDENTIAL_INVALID', { [BEARER_ENV]: 'Secret With Spaces 0123456789' }],
      ['a credential header named Authorization', executorConfiguration({ clientCredential: { kind: 'header', name: 'authorization', valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['the presentation header as credential', executorConfiguration({ clientCredential: { kind: 'header', name: EXECUTION_CAPABILITY_PRESENTATION_HEADER, valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['Host as credential', executorConfiguration({ clientCredential: { kind: 'header', name: 'host', valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['a credential header admission always refuses', executorConfiguration({ clientCredential: { kind: 'header', name: 'x-real-ip', valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['an X-Forwarded credential header', executorConfiguration({ clientCredential: { kind: 'header', name: 'x-forwarded-key', valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['too many issuers', executorConfiguration({ trustedIssuers: Array.from({ length: 9 }, (_, index) => ({ issuer: `issuer-${String(index)}`, keys: [{ ...pin(ISSUER_KEY), keyId: `key-${String(index)}` }] })) }), 'LIMIT_INVALID'],
      ['an upper-case credential header', executorConfiguration({ clientCredential: { kind: 'header', name: 'X-Gateway-Key', valueEnv: BEARER_ENV } }), 'CREDENTIAL_INVALID'],
      ['a lifetime past the profile maximum', executorConfiguration({ maximumLifetimeMs: 60_001 }), 'LIMIT_INVALID'],
      ['a zero lifetime', executorConfiguration({ maximumLifetimeMs: 0 }), 'LIMIT_INVALID'],
      ['a skew past the profile maximum', executorConfiguration({ maximumClockSkewMs: 5_001 }), 'LIMIT_INVALID'],
      ['an online status policy', executorConfiguration({ statusPolicy: 'online-required' }), 'STATUS_POLICY_UNSUPPORTED'],
      ['a public listener', executorConfiguration({ listen: { host: '0.0.0.0', port: 0 } }), 'RUNTIME_UNSAFE'],
      ['a listener by name', executorConfiguration({ listen: { host: 'localhost', port: 0 } }), 'RUNTIME_UNSAFE'],
      ['a negative port', executorConfiguration({ listen: { host: '127.0.0.1', port: -1 } }), 'LIMIT_INVALID'],
    ];
    for (const [name, raw, code, environment] of cases) assert.equal(refusedCode(raw, environment ?? EXECUTOR_ENVIRONMENT), code, name);
  });
});

// ── The verification pipeline ───────────────────────────────────────────────

const pipeline = createReferenceExecutorVerificationPipeline(parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT), () => Date.now());
const now = Date.now();
const at = (offsetMs: number): string => new Date(Date.now() + offsetMs).toISOString();

function expectRefused(assessment: ReferenceExecutorAssessment, stage: ReferenceExecutorAssessment['stage'], code: ReferenceExecutorAssessment['code'], name: string): void {
  assert.deepEqual({ outcome: assessment.outcome, stage: assessment.stage, code: assessment.code }, { outcome: 'refused', stage, code }, name);
}

describe('G-02C1A — the verification pipeline', () => {
  it('an exact request with a valid capability is assessed eligible — verification only — with the Host’s digest rebuilt from what was received', () => {
    for (const vector of [WITH_BODY, NO_BODY, DELETE]) {
      const assessment = pipeline.assess(observedWith(vector));
      assert.deepEqual(assessment, { mode: 'verification-only', outcome: 'assessed-eligible', stage: 'eligibility', code: 'VERIFICATION_ONLY', bindingDigest: vector.digest }, vector.name);
      assert.equal(referenceExecutorStatusOf(assessment), 409, 'an eligible assessment is never a 2xx');
    }
  });

  it('rotation overlap and a second pinned issuer: each key vouches only for its own issuer', () => {
    assert.equal(pipeline.assess(observedWith(WITH_BODY, { capability: { issuerKeyId: ISSUER_ROTATED_KEY.keyId }, key: ISSUER_ROTATED_KEY })).outcome, 'assessed-eligible');
    assert.equal(pipeline.assess(observedWith(WITH_BODY, { capability: { issuer: OTHER_ISSUER, issuerKeyId: OTHER_ISSUER_KEY.keyId }, key: OTHER_ISSUER_KEY })).outcome, 'assessed-eligible');
    expectRefused(pipeline.assess(observedWith(WITH_BODY, { capability: { issuer: OTHER_ISSUER } })), 'verification', 'ISSUER_KEY_MISMATCH', 'a pinned key presented for another pinned issuer');
  });

  it('admission refuses what the Host transport never sends', () => {
    const cases: readonly (readonly [string, Parameters<typeof observedWith>[1], ReferenceExecutorAssessment['code']])[] = [
      ['HTTP/1.0', { httpVersion: '1.0' }, 'HTTP_VERSION_UNSUPPORTED'],
      ['HTTP/2', { httpVersion: '2.0' }, 'HTTP_VERSION_UNSUPPORTED'],
      ['GET (the Host adapter has no GET)', { method: 'GET' }, 'METHOD_NOT_PERMITTED'],
      ['an absolute-form target', { target: `https://${HOSTNAME}/v1/deployments/${RESOURCE}` }, 'REQUEST_TARGET_INVALID'],
      ['an asterisk target', { target: '*' }, 'REQUEST_TARGET_INVALID'],
      ['a fragment', { target: `/v1/deployments/${RESOURCE}#x` }, 'REQUEST_TARGET_INVALID'],
      ['a duplicated header', { edit: (raw) => addRawHeader(raw, 'x-release-channel', 'stable') }, 'HEADER_DUPLICATED'],
      ['a duplicated header in another case', { edit: (raw) => addRawHeader(raw, 'X-Release-Channel', 'canary') }, 'HEADER_DUPLICATED'],
      ['two Host headers', { edit: (raw) => addRawHeader(raw, 'host', HOSTNAME) }, 'HEADER_DUPLICATED'],
      ['two presentations', { edit: (raw) => addRawHeader(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, 'AAAA') }, 'HEADER_DUPLICATED'],
      ['transfer-encoding', { edit: (raw) => addRawHeader(raw, 'Transfer-Encoding', 'chunked') }, 'FRAMING_UNSUPPORTED'],
      ['trailers', { edit: (raw) => addRawHeader(raw, 'Trailer', 'x-sum') }, 'FRAMING_UNSUPPORTED'],
      ['an upgrade', { edit: (raw) => addRawHeader(raw, 'Upgrade', 'h2c') }, 'UPGRADE_REFUSED'],
      ['HTTP2-Settings', { edit: (raw) => addRawHeader(raw, 'HTTP2-Settings', 'AAMAAABkAAQAAP__') }, 'UPGRADE_REFUSED'],
      ['an expectation', { edit: (raw) => addRawHeader(raw, 'Expect', '100-continue') }, 'EXPECTATION_REFUSED'],
      ['Via', { edit: (raw) => addRawHeader(raw, 'Via', '1.1 edge-proxy') }, 'PROXY_REWRITE_REFUSED'],
      ['Forwarded', { edit: (raw) => addRawHeader(raw, 'Forwarded', 'for=203.0.113.9') }, 'PROXY_REWRITE_REFUSED'],
      ['X-Forwarded-For', { edit: (raw) => addRawHeader(raw, 'X-Forwarded-For', '203.0.113.9') }, 'PROXY_REWRITE_REFUSED'],
      ['a content coding', { edit: (raw) => addRawHeader(raw, 'Content-Encoding', 'gzip') }, 'CONTENT_ENCODING_UNSUPPORTED'],
      ['no Host', { edit: (raw) => dropRawHeader(raw, 'host') }, 'HOST_MISSING'],
      ['another Host', { authority: 'other.executor.example' }, 'HOST_MISMATCH'],
      ['another port', { authority: `${HOSTNAME}:8443` }, 'HOST_MISMATCH'],
      ['Host in another case', { authority: HOSTNAME.toUpperCase() }, 'HOST_MISMATCH'],
      ['keep-alive', { edit: (raw) => setRawHeader(raw, 'connection', 'keep-alive') }, 'CONNECTION_UNEXPECTED'],
      ['no Connection', { edit: (raw) => dropRawHeader(raw, 'connection') }, 'CONNECTION_UNEXPECTED'],
      ['a control character in a value', { edit: (raw) => setRawHeader(raw, 'x-release-channel', 'sta\u0001ble') }, 'HEADER_VALUE_INVALID'],
      ['a non-ASCII value', { edit: (raw) => setRawHeader(raw, 'x-release-channel', 'stäble') }, 'HEADER_VALUE_INVALID'],
      ['a length that is not the body', { edit: (raw) => setRawHeader(raw, 'content-length', '3') }, 'FRAMING_AMBIGUOUS'],
      ['a body with no length', { edit: (raw) => dropRawHeader(raw, 'content-length') }, 'FRAMING_AMBIGUOUS'],
      ['a body that is not UTF-8', { body: Buffer.from([0x7b, 0xff, 0x7d]), edit: (raw) => setRawHeader(raw, 'content-length', '3') }, 'BODY_NOT_UTF8'],
      ['a body over the bound', { body: Buffer.alloc(64 * 1024 + 1, 0x61), edit: (raw) => setRawHeader(raw, 'content-length', String(64 * 1024 + 1)) }, 'BODY_TOO_LARGE'],
      ['no presentation', { edit: (raw) => dropRawHeader(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER) }, 'PRESENTATION_MISSING'],
      ['no credential', { edit: (raw) => dropRawHeader(raw, 'authorization') }, 'CLIENT_CREDENTIAL_MISSING'],
      ['too many headers', { edit: (raw) => Array.from({ length: 48 }, (_, index) => [`x-filler-${String(index)}`, 'x']).flat().concat(raw) }, 'HEADER_COUNT_EXCEEDED'],
    ];
    for (const [name, options, code] of cases) expectRefused(pipeline.assess(observedWith(WITH_BODY, options)), 'admission', code, name);
  });

  it('the client credential is compared exactly, in constant time, after admission', () => {
    expectRefused(pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', `Bearer ${BEARER}x`) })), 'credential', 'CLIENT_UNAUTHENTICATED', 'a longer credential');
    expectRefused(pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', `bearer ${BEARER}`) })), 'credential', 'CLIENT_UNAUTHENTICATED', 'another spelling of the scheme');
    expectRefused(pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', '') })), 'credential', 'CLIENT_UNAUTHENTICATED', 'an empty credential');
    const refused = pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', 'Bearer wrong') }));
    assert.equal(refused.bindingDigest, null, 'an unauthenticated caller learns no digest');
  });

  it('the executor’s own policy refuses before the signature is weighed', () => {
    const cases: readonly (readonly [string, Parameters<typeof capabilityFor>[1], ReferenceExecutorAssessment['code']])[] = [
      ['an issuer this executor never pinned', { issuer: 'frontera-deployment-unknown' }, 'ISSUER_NOT_PINNED'],
      ['another audience', { audience: 'executor-elsewhere' }, 'AUDIENCE_NOT_THIS_EXECUTOR'],
      ['another organization', { organizationId: 'org-elsewhere' }, 'ORGANIZATION_NOT_PERMITTED'],
      ['another trust domain', { trustDomain: 'trust-domain-elsewhere' }, 'TRUST_DOMAIN_NOT_PERMITTED'],
      ['an action not on the allow-list', { action: 'drop-database' }, 'ACTION_NOT_PERMITTED'],
      ['a resource not on the allow-list', { resource: 'cluster-us-9' }, 'RESOURCE_NOT_PERMITTED'],
    ];
    for (const [name, overrides, code] of cases) expectRefused(pipeline.assess(observedWith(WITH_BODY, { capability: overrides ?? {} })), 'policy', code, name);
  });

  it('G-02A verification decides: signature, pinned key, domain, window and the exact rebuilt binding', () => {
    const capability = capabilityFor(WITH_BODY.digest);
    const canonical = serializeExecutionCapability(capability);
    const presentWith = (signature: ReturnType<typeof signatureOver>, text = canonical): string => rawPresentation(envelopeOf(text, signature));
    const flipped = signatureOver(executionCapabilitySigningBytes(capability), ISSUER_KEY);
    const bytes = Buffer.from(flipped.signature, 'base64url');
    bytes[10] = (bytes[10] ?? 0) ^ 0x01;
    const cases: readonly (readonly [string, Parameters<typeof observedWith>[1], ReferenceExecutorAssessment['code']])[] = [
      ['a forged signature', { presentation: presentWith({ ...flipped, signature: bytes.toString('base64url') }) }, 'SIGNATURE_INVALID'],
      ['a signature by an unpinned key under a pinned key id', { presentation: presentWith(signatureOver(executionCapabilitySigningBytes(capability), UNPINNED_KEY, ISSUER_KEY.keyId)) }, 'SIGNATURE_INVALID'],
      ['an unpinned key id', { capability: { issuerKeyId: UNPINNED_KEY.keyId }, key: UNPINNED_KEY }, 'ISSUER_KEY_MISMATCH'],
      ['the grant signing domain substituted', { presentation: presentWith(signatureOver(Buffer.from(`${AUTHORITY_SIGNING_DOMAINS.grant}${canonical}`, 'utf8'), ISSUER_KEY)) }, 'SIGNATURE_INVALID'],
      ['no signing domain', { presentation: presentWith(signatureOver(Buffer.from(canonical, 'utf8'), ISSUER_KEY)) }, 'SIGNATURE_INVALID'],
      ['expired', { capability: { issuedAt: at(-40_000), expiresAt: at(-10_000) } }, 'CAPABILITY_EXPIRED'],
      ['issued too far ahead of the clock', { capability: { issuedAt: at(10_000), expiresAt: at(40_000) } }, 'CAPABILITY_NOT_YET_VALID'],
      ['a window past the profile maximum', { capability: { issuedAt: at(-1_000), expiresAt: at(60_000) } }, 'CAPABILITY_LIFETIME_INVALID'],
      ['a capability for another request', { capability: { actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest: NO_BODY.digest } } }, 'ACTION_BINDING_MISMATCH'],
      ['the right request with one header value changed', { edit: (raw) => setRawHeader(raw, 'x-release-channel', 'canary') }, 'ACTION_BINDING_MISMATCH'],
      ['the right request with an extra header', { edit: (raw) => addRawHeader(raw, 'x-extra', '1') }, 'ACTION_BINDING_MISMATCH'],
      ['the right request at another path', { target: WITH_BODY.request.path.replace(RESOURCE, 'cluster-eu-2') }, 'ACTION_BINDING_MISMATCH'],
      ['the right request with another method', { method: 'PUT' }, 'ACTION_BINDING_MISMATCH'],
      ['the right request with another body of the same length', { body: Buffer.from(WITH_BODY.request.body?.replace('7500', '7501') ?? '', 'utf8') }, 'ACTION_BINDING_MISMATCH'],
    ];
    for (const [name, options, code] of cases) {
      const assessment = pipeline.assess(observedWith(WITH_BODY, options));
      expectRefused(assessment, 'verification', code, name);
      assert.equal(assessment.bindingDigest, null, `${name}: no digest on a refusal`);
    }
    assert.ok(now > 0);
  });

  it('a configured lifetime shorter than the profile maximum is enforced', () => {
    const strict = createReferenceExecutorVerificationPipeline(parseReferenceExecutorConfiguration(executorConfiguration({ maximumLifetimeMs: 20_000 }), EXECUTOR_ENVIRONMENT), () => Date.now());
    expectRefused(strict.assess(observedWith(WITH_BODY)), 'verification', 'CAPABILITY_LIFETIME_INVALID', 'a 30 s capability under a 20 s policy');
  });

  it('a status-required capability verifies but is never eligible before G-02D', () => {
    const assessment = pipeline.assess(observedWith(WITH_BODY, { capability: { statusRequirement: 'online-status-required' } }));
    assert.deepEqual({ outcome: assessment.outcome, stage: assessment.stage, code: assessment.code }, { outcome: 'assessed-ineligible', stage: 'eligibility', code: 'STATUS_REQUIRED_UNAVAILABLE' });
    assert.equal(referenceExecutorStatusOf(assessment), 403);
  });

  it('the Content-Length: 0 rule is exactly the Host transport’s, and nothing wider', () => {
    // A body-less POST must carry exactly one `Content-Length: 0`, which is left out of the record; nothing else is.
    assert.equal(pipeline.assess(observedWith(NO_BODY)).outcome, 'assessed-eligible');
    expectRefused(pipeline.assess(observedWith(NO_BODY, { edit: (raw) => dropRawHeader(raw, 'content-length') })), 'binding', 'FRAMING_UNEXPECTED', 'a body-less POST without its length');
    expectRefused(pipeline.assess(observedWith(NO_BODY, { edit: (raw) => setRawHeader(raw, 'content-length', '00') })), 'binding', 'FRAMING_UNEXPECTED', 'another spelling of zero');
    // DELETE gets no length from the Host transport, so a received one is bound — and the Host never bound one.
    assert.equal(pipeline.assess(observedWith(DELETE)).outcome, 'assessed-eligible');
    expectRefused(pipeline.assess(observedWith(DELETE, { edit: (raw) => addRawHeader(raw, 'Content-Length', '0') })), 'verification', 'ACTION_BINDING_MISMATCH', 'a DELETE carrying Content-Length: 0');
    // With a body, content-length is bound as received.
    expectRefused(pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'content-length', `0${String(WITH_BODY.request.body?.length)}`) })), 'verification', 'ACTION_BINDING_MISMATCH', 'a leading-zero length');
  });

  it('no refusal is ever more than an answer: a closed five-field record, no secret, no digest before the credential', () => {
    const samples = [
      pipeline.assess(observedWith(WITH_BODY, { httpVersion: '1.0' })),
      pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', 'Bearer wrong') })),
      pipeline.assess(observedWith(WITH_BODY, { presentation: 'AAAA' })),
      pipeline.assess(observedWith(WITH_BODY, { capability: { action: 'drop-database' } })),
      pipeline.assess(observedWith(WITH_BODY, { edit: (raw) => addRawHeader(raw, 'x-extra', '1') })),
      pipeline.assess(observedWith(WITH_BODY, { capability: { statusRequirement: 'online-status-required' } })),
    ];
    for (const assessment of samples) {
      assert.deepEqual(Object.keys(assessment).sort(), ['bindingDigest', 'code', 'mode', 'outcome', 'stage']);
      assert.ok(Object.isFrozen(assessment));
      assert.notEqual(assessment.outcome, 'assessed-eligible');
      assert.ok(referenceExecutorStatusOf(assessment) >= 400 && referenceExecutorStatusOf(assessment) < 500);
      const shown = JSON.stringify(assessment);
      for (const secret of [BEARER, 'capabilityId', 'agent:release-bot', ACTION, ISSUER]) assert.equal(shown.includes(secret), false, secret);
    }
    assert.equal(samples[0]?.bindingDigest, null);
    assert.equal(samples[1]?.bindingDigest, null);
  });
});
