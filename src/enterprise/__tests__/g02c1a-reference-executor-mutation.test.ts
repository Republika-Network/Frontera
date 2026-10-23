import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { executionCapabilityActionBindingDigest, executionCapabilitySigningBytes, serializeExecutionCapability } from '../execution-capability/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_FORMAT } from '../execution-capability-presentation/index.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT } from '../execution-adapters/generic-http/request-binding.js';
import { REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, admitHttpRequest, parseReferenceExecutorConfiguration, type ObservedHttpRequest, type ReferenceExecutorAssessment } from '../reference-executor/index.js';
import {
  EXECUTOR_ENVIRONMENT,
  ISSUER,
  ISSUER_KEY,
  OTHER_ISSUER,
  OTHER_ISSUER_KEY,
  RESOURCE,
  addRawHeader,
  capabilityFor,
  executorConfiguration,
  hostVector,
  observedWith,
  pin,
  presentationFor,
  rawPresentation,
  serializeRaw,
  parseRaw,
  setRawHeader,
  signatureOver,
} from './g02c1a-reference-executor-fixture.js';

/**
 * G-02C1A mutation qualification, in the manner of G-02A … G-02C0: each
 * load-bearing control is removed from the **compiled** module, the mutant is
 * loaded beside the original, and its guard must hold for the original and
 * fail for the mutant. Each guard presents a case whose every other check
 * agrees, so only the removed control stands between it and acceptance.
 * Mutation sites name only module-local identifiers on one emitted line.
 *
 * The G-02A verifier's own checks (signature, window, audience, action,
 * resource, binding digest) are qualified by G-02A's mutants; here the
 * executor's use of them, and its own controls, are mutated.
 */

const load = createRequire(__filename);
const ROOT = join(__dirname, '..');

interface Mutant<M> {
  readonly id: string;
  readonly file: string;
  readonly replacements: readonly (readonly [string, string])[];
  readonly guard: (module: M) => boolean | Promise<boolean>;
}

async function qualify<M>(mutant: Mutant<M>): Promise<void> {
  const path = join(ROOT, mutant.file);
  let source = readFileSync(path, 'utf8');
  for (const [search, replace] of mutant.replacements) {
    assert.equal(source.split(search).length - 1, 1, `${mutant.id}: the mutation site must occur exactly once in ${mutant.file}: ${search.slice(0, 60)}`);
    source = source.replace(search, replace);
  }
  const mutantPath = path.replace(/\.js$/, `.mutant-g02c1a-${mutant.id}.js`);
  writeFileSync(mutantPath, source);
  try {
    assert.equal(await mutant.guard(load(path) as M), true, `${mutant.id}: the guard holds for the shipped module`);
    assert.equal(await mutant.guard(load(mutantPath) as M), false, `${mutant.id}: the guard detects the removed control`);
  } finally {
    delete load.cache[load.resolve(mutantPath)];
    rmSync(mutantPath, { force: true });
  }
}

const CONFIGURATION = parseReferenceExecutorConfiguration(executorConfiguration(), EXECUTOR_ENVIRONMENT);
const POLICY = { authority: CONFIGURATION.origin.authority, methods: CONFIGURATION.methods, credentialHeader: CONFIGURATION.credential.header };
const WITH_BODY = hostVector('POST with body and headers', {
  body: { kind: 'json-object', fields: { subject: { kind: 'source', source: 'subject' }, amount: { kind: 'source', source: 'amount.value' } } },
  headers: { 'X-Release-Channel': { kind: 'literal', value: 'stable' }, 'Idempotency-Key': { kind: 'source', source: 'correlation.executionId' } },
});
const NO_BODY = hostVector('POST without body');
const DELETE = hostVector('DELETE without body', { method: 'DELETE' });

function admitted(observed: ObservedHttpRequest) {
  const admission = admitHttpRequest(observed, POLICY);
  assert.ok(admission.ok, 'the guard case passes admission');
  return admission.request;
}

const digestOf = (value: unknown): string => executionCapabilityActionBindingDigest({ format: REFERENCE_EXECUTOR_HTTP_BINDING_FORMAT, value });

// ── Admission ───────────────────────────────────────────────────────────────

type AdmissionModule = typeof import('../reference-executor/admission.js');
const ADMISSION = join('reference-executor', 'admission.js');

describe('G-02C1A mutation — admission', () => {
  const mutants: readonly Mutant<AdmissionModule>[] = [
    {
      id: 'duplicate-header-accepted',
      file: ADMISSION,
      replacements: [['if (seen.has(name))', 'if (false)']],
      // Two Host headers: the first names another origin, the last this one. Only the duplicate refusal stops the last from winning.
      guard: (m) => !m.admitHttpRequest(observedWith(NO_BODY, { edit: (raw) => ['Host', 'evil.example', ...raw] }), POLICY).ok,
    },
    {
      id: 'host-not-checked',
      file: ADMISSION,
      replacements: [['if (host !== policy.authority)', 'if (false)']],
      guard: (m) => !m.admitHttpRequest(observedWith(NO_BODY, { authority: 'evil.example' }), POLICY).ok,
    },
    {
      id: 'connection-not-checked',
      file: ADMISSION,
      replacements: [["if (connection !== 'close')", 'if (false)']],
      guard: (m) => !m.admitHttpRequest(observedWith(NO_BODY, { edit: (raw) => setRawHeader(raw, 'connection', 'keep-alive') }), POLICY).ok,
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── Binding reconstruction ──────────────────────────────────────────────────

type ReconstructionModule = typeof import('../reference-executor/binding-reconstruction.js');
const RECONSTRUCTION = join('reference-executor', 'binding-reconstruction.js');

describe('G-02C1A mutation — binding reconstruction', () => {
  const rebuild = (m: ReconstructionModule, observed: ObservedHttpRequest) => m.reconstructHttpRequestBinding(admitted(observed), CONFIGURATION.origin, CONFIGURATION.credential.header);
  const mutants: readonly Mutant<ReconstructionModule>[] = [
    {
      id: 'zero-length-exception-for-every-method',
      file: RECONSTRUCTION,
      replacements: [['&& ZERO_LENGTH_METHODS.includes(request.method)', '']],
      // DELETE gets no length from the Host transport, so a received Content-Length: 0 must stay in the record.
      guard: (m) => {
        const rebuilt = rebuild(m, observedWith(DELETE, { edit: (raw) => addRawHeader(raw, 'Content-Length', '0') }));
        return rebuilt.ok && rebuilt.binding.headers.some(([name]) => name === 'content-length');
      },
    },
    {
      id: 'zero-length-other-spelling',
      file: RECONSTRUCTION,
      replacements: [["if (lengths.length !== 1 || lengths[0]?.[1] !== '0')", 'if (lengths.length !== 1)']],
      guard: (m) => !rebuild(m, observedWith(NO_BODY, { edit: (raw) => setRawHeader(raw, 'content-length', '00') })).ok,
    },
    {
      id: 'body-unbound',
      file: RECONSTRUCTION,
      replacements: [['body: request.body', 'body: null']],
      guard: (m) => {
        const original = rebuild(m, observedWith(WITH_BODY));
        const altered = rebuild(m, observedWith(WITH_BODY, { body: Buffer.from(WITH_BODY.request.body?.replace('7500', '7501') ?? '', 'utf8') }));
        return original.ok && altered.ok && digestOf(original.binding) !== digestOf(altered.binding);
      },
    },
    {
      id: 'target-unbound',
      file: RECONSTRUCTION,
      replacements: [['target: request.target', "target: '/'"]],
      guard: (m) => {
        const original = rebuild(m, observedWith(WITH_BODY));
        const altered = rebuild(m, observedWith(WITH_BODY, { target: WITH_BODY.request.path.replace(RESOURCE, 'cluster-eu-2') }));
        return original.ok && altered.ok && digestOf(original.binding) !== digestOf(altered.binding);
      },
    },
    {
      id: 'headers-unsorted',
      file: RECONSTRUCTION,
      replacements: [['.sort(byName)', '']],
      // Received in send order, bound sorted: only the sort makes the executor's record the Host's.
      guard: (m) => {
        const rebuilt = rebuild(m, observedWith(WITH_BODY));
        return rebuilt.ok && digestOf(rebuilt.binding) === WITH_BODY.digest;
      },
    },
    {
      id: 'credential-header-name-unbound',
      file: RECONSTRUCTION,
      replacements: [['credentialHeader: credentialHeaderName', 'credentialHeader: null']],
      guard: (m) => {
        const rebuilt = rebuild(m, observedWith(WITH_BODY));
        return rebuilt.ok && digestOf(rebuilt.binding) === WITH_BODY.digest;
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The pipeline ────────────────────────────────────────────────────────────

type PipelineModule = typeof import('../reference-executor/verification-pipeline.js');
const PIPELINE = join('reference-executor', 'verification-pipeline.js');

describe('G-02C1A mutation — the verification pipeline', () => {
  const assess = (m: PipelineModule, observed: ObservedHttpRequest): ReferenceExecutorAssessment => m.createReferenceExecutorVerificationPipeline(CONFIGURATION, () => Date.now()).assess(observed);
  const forged = (): string => {
    const capability = capabilityFor(WITH_BODY.digest);
    const signature = signatureOver(executionCapabilitySigningBytes(capability), ISSUER_KEY);
    const bytes = Buffer.from(signature.signature, 'base64url');
    bytes[3] = (bytes[3] ?? 0) ^ 0x80;
    return rawPresentation({ bindingFormat: GENERIC_HTTP_REQUEST_BINDING_FORMAT, capability: serializeExecutionCapability(capability), format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature: { ...signature, signature: bytes.toString('base64url') } });
  };
  const mutants: readonly Mutant<PipelineModule>[] = [
    {
      id: 'credential-not-checked',
      file: PIPELINE,
      replacements: [['if (!authenticated)', 'if (false)']],
      guard: (m) => assess(m, observedWith(WITH_BODY, { edit: (raw) => setRawHeader(raw, 'authorization', 'Bearer not-the-gateway-credential') })).outcome === 'refused',
    },
    {
      id: 'action-allow-list-skipped',
      file: PIPELINE,
      replacements: [['if (!actionPermitted)', 'if (false)']],
      // Validly signed, exactly bound, for an action this executor never permits: G-02A verifies it, only the allow-list refuses.
      guard: (m) => assess(m, observedWith(WITH_BODY, { capability: { action: 'drop-database' } })).outcome === 'refused',
    },
    {
      id: 'resource-allow-list-skipped',
      file: PIPELINE,
      replacements: [['if (!resourcePermitted)', 'if (false)']],
      guard: (m) => assess(m, observedWith(WITH_BODY, { capability: { resource: 'cluster-us-9' } })).outcome === 'refused',
    },
    {
      id: 'status-required-eligible',
      file: PIPELINE,
      replacements: [["const eligible = verified !== undefined && verified.consumptionEligible && verified.capability.statusRequirement === 'offline-permitted' && configuration.statusPolicy === 'offline-only';", 'const eligible = verified !== undefined;']],
      guard: (m) => assess(m, observedWith(WITH_BODY, { capability: { statusRequirement: 'online-status-required' } })).outcome !== 'assessed-eligible',
    },
    {
      id: 'verification-ignored',
      file: PIPELINE,
      replacements: [
        ["if (verification.verification !== 'verified')", 'if (false)'],
        ['const eligible = verified !== undefined && ', 'const eligible = true || '],
      ],
      guard: (m) => assess(m, observedWith(WITH_BODY, { presentation: forged() })).outcome === 'refused',
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The configuration ───────────────────────────────────────────────────────

type ConfigurationModule = typeof import('../reference-executor/configuration.js');
const CONFIGURATION_FILE = join('reference-executor', 'configuration.js');

function refusesWith(m: ConfigurationModule, raw: Record<string, unknown>, code: string): boolean {
  try {
    m.parseReferenceExecutorConfiguration(raw, EXECUTOR_ENVIRONMENT);
    return false;
  } catch (error) {
    return (error as { readonly code?: unknown }).code === code;
  }
}

describe('G-02C1A mutation — the closed configuration', () => {
  const mutants: readonly Mutant<ConfigurationModule>[] = [
    {
      id: 'wildcard-identity-accepted',
      file: CONFIGURATION_FILE,
      replacements: [["|| value.includes('*'))", ')']],
      guard: (m) => refusesWith(m, executorConfiguration({ organizationIds: ['org-*'] }), 'IDENTITY_INVALID'),
    },
    {
      id: 'duplicate-key-material-accepted',
      file: CONFIGURATION_FILE,
      replacements: [['if (materials.has(material))', 'if (false)']],
      guard: (m) => refusesWith(m, executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [pin(ISSUER_KEY)] }, { issuer: OTHER_ISSUER, keys: [{ ...pin(ISSUER_KEY), keyId: 'g02c1a-copy' }] }] }), 'KEY_OWNERSHIP_DUPLICATE'),
    },
    {
      id: 'duplicate-key-id-accepted',
      file: CONFIGURATION_FILE,
      replacements: [['if (keyIds.has(keyId))', 'if (false)']],
      guard: (m) => refusesWith(m, executorConfiguration({ trustedIssuers: [{ issuer: ISSUER, keys: [pin(ISSUER_KEY)] }, { issuer: OTHER_ISSUER, keys: [{ ...pin(OTHER_ISSUER_KEY), keyId: ISSUER_KEY.keyId }] }] }), 'KEY_OWNERSHIP_DUPLICATE'),
    },
    {
      id: 'public-listener-accepted',
      file: CONFIGURATION_FILE,
      replacements: [["if (host !== '127.0.0.1' && host !== '::1')", 'if (false)']],
      guard: (m) => refusesWith(m, executorConfiguration({ listen: { host: '0.0.0.0', port: 0 } }), 'RUNTIME_UNSAFE'),
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The presentation codec ──────────────────────────────────────────────────

type PresentationModule = typeof import('../execution-capability-presentation/presentation.js');
const PRESENTATION = join('execution-capability-presentation', 'presentation.js');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** A valid presentation re-spelled with one stray trailing bit set: the same bytes, a second spelling. */
function strayBitSpelling(): string {
  for (let pad = 0; pad < 3; pad += 1) {
    const encoded = presentationFor(capabilityFor(WITH_BODY.digest, { executionId: `aoc.exec:${'e'.repeat(10 + pad)}` }));
    if (encoded.length % 4 === 0) continue;
    const index = ALPHABET.indexOf(encoded.slice(-1));
    return `${encoded.slice(0, -1)}${ALPHABET.charAt(index + 1)}`;
  }
  return assert.fail('no presentation length left stray bits');
}

describe('G-02C1A mutation — the presentation codec', () => {
  const whitespace = (): string => {
    const text = Buffer.from(presentationFor(capabilityFor(WITH_BODY.digest)), 'base64url').toString('utf8');
    return Buffer.from(JSON.stringify(JSON.parse(text) as unknown, null, 1), 'utf8').toString('base64url');
  };
  const mutants: readonly Mutant<PresentationModule>[] = [
    {
      id: 'noncanonical-envelope-accepted',
      file: PRESENTATION,
      replacements: [['if (canonical !== text)', 'if (false)']],
      guard: (m) => !m.decodeExecutionCapabilityPresentation(whitespace()).ok,
    },
    {
      id: 'second-base64-spelling-accepted',
      file: PRESENTATION,
      replacements: [["if (bytes.toString('base64url') !== encoded)", 'if (false)']],
      guard: (m) => !m.decodeExecutionCapabilityPresentation(strayBitSpelling()).ok,
    },
    {
      id: 'binding-format-mismatch-accepted',
      file: PRESENTATION,
      replacements: [['if (parsedCapability.capability.actionBinding.format !== bindingFormat)', 'if (false)']],
      guard: (m) => {
        const capability = capabilityFor(WITH_BODY.digest);
        const envelope = { bindingFormat: 'frontera.batch-job-binding.v1', capability: serializeExecutionCapability(capability), format: EXECUTION_CAPABILITY_PRESENTATION_FORMAT, signature: signatureOver(executionCapabilitySigningBytes(capability), ISSUER_KEY) };
        return !m.decodeExecutionCapabilityPresentation(rawPresentation(envelope)).ok;
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});

// ── The gateway ─────────────────────────────────────────────────────────────

type GatewayModule = typeof import('../reference-executor/gateway.js');
const GATEWAY = join('reference-executor', 'gateway.js');

/** Two keep-alive requests on one connection to a gateway built by `m`: does it refuse the second as pipelined? */
async function refusesPipelining(m: GatewayModule): Promise<boolean> {
  const seen: { readonly code: string }[] = [];
  const gateway = await m.startReferenceExecutorGateway({ configuration: CONFIGURATION, clock: () => Date.now(), onAssessment: (assessment) => seen.push(assessment) });
  try {
    const request = (): Buffer => {
      const observed = observedWith(NO_BODY, { edit: (raw) => setRawHeader(raw, 'connection', 'keep-alive') });
      const lines = [`${observed.method} ${observed.target} HTTP/1.1`];
      for (let index = 0; index + 1 < observed.rawHeaders.length; index += 2) lines.push(`${String(observed.rawHeaders[index])}: ${String(observed.rawHeaders[index + 1])}`);
      return serializeRaw(parseRaw(Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1')));
    };
    await new Promise<void>((done) => {
      const socket = connect({ host: '127.0.0.1', port: gateway.port });
      const timer = setTimeout(() => {
        socket.destroy();
        done();
      }, 1_000);
      socket.on('error', () => undefined);
      socket.on('close', () => {
        clearTimeout(timer);
        done();
      });
      socket.write(Buffer.concat([request(), request()]));
    });
    await new Promise((settle) => setTimeout(settle, 100));
    return seen.some((assessment) => assessment.code === 'REQUEST_PIPELINED');
  } finally {
    await gateway.close();
  }
}

describe('G-02C1A mutation — the gateway', () => {
  const mutants: readonly Mutant<GatewayModule>[] = [
    {
      id: 'pipelined-request-handled',
      file: GATEWAY,
      replacements: [['if (served.has(req.socket))', 'if (false)']],
      guard: refusesPipelining,
    },
    {
      id: 'eligible-answered-2xx',
      file: GATEWAY,
      replacements: [['return 409;', 'return 200;']],
      // A 2xx would be read by the Host's classifier as a completed effect.
      guard: (m) => {
        const status = m.referenceExecutorStatusOf({ mode: 'verification-only', outcome: 'assessed-eligible', stage: 'eligibility', code: 'VERIFICATION_ONLY', bindingDigest: WITH_BODY.digest });
        return status >= 400 && status < 500;
      },
    },
  ];
  for (const mutant of mutants) it(mutant.id, () => qualify(mutant));
});
