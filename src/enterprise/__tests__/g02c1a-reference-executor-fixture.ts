import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

import type { ValidatedExecutionAction } from '../../features/execution-runtime/index.js';
import type { GovernedParameter } from '../../features/governed-parameter-runtime/index.js';
import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/index.js';
import type { EnterpriseGenericHttpExecutionAdapterOptions } from '../execution-adapters/generic-http/contracts.js';
import { snapshotGenericHttpOptions, type GenericHttpPlan } from '../execution-adapters/generic-http/configuration.js';
import { sendOnce, type GenericHttpRequestPrimitive, type GenericHttpTransportObservation } from '../execution-adapters/generic-http/node-https-transport.js';
import { GENERIC_HTTP_REQUEST_BINDING_FORMAT, genericHttpRequestBinding } from '../execution-adapters/generic-http/request-binding.js';
import { mapGenericHttpRequest, type GenericHttpWireRequest } from '../execution-adapters/generic-http/request-mapper.js';
import { EXECUTION_CAPABILITY_FORMAT, executionCapabilityActionBindingDigest, executionCapabilitySigningBytes, serializeExecutionCapability, type ExecutionCapability } from '../execution-capability/index.js';
import { EXECUTION_CAPABILITY_PRESENTATION_HEADER, encodeExecutionCapabilityPresentation } from '../execution-capability-presentation/index.js';
import { canonicalSerialize } from '../governance-store/canonical-json.js';
import type { ObservedHttpRequest, ReferenceExecutorAssessment } from '../reference-executor/index.js';

/**
 * G-02C1A fixtures — test-only, synthetic, loopback.
 *
 * Two sides that share nothing at runtime:
 *
 * - **Host-like side (this process).** Requests are built by the real G-02C0
 *   Generic HTTP mapper from a real plan and a validated action; their binding
 *   digest by the real `genericHttpRequestBinding`. Capabilities are signed
 *   here, with private keys that exist only in this process's memory. Bytes
 *   are written by the Host's real transport (`sendOnce` + the exact
 *   `https.request` options it builds), with one substitution: plain HTTP to a
 *   loopback port instead of TLS to a public address (`loopbackPrimitive`).
 * - **Executor side (a child process).** `scripts/run-reference-executor.mjs`,
 *   given only a configuration file of public keys and identities, and the one
 *   credential variable. Its own Node HTTP parser reads the bytes.
 */

// ── Identities ──────────────────────────────────────────────────────────────

export const ISSUER = 'frontera-deployment-g02c1a';
export const OTHER_ISSUER = 'frontera-deployment-other';
export const ORGANIZATION = 'org-g02c1a';
export const TRUST_DOMAIN = 'trust-domain-g02c1a';
export const AUDIENCE = 'executor-g02c1a-gateway';
export const EXECUTOR_ID = 'reference-executor-g02c1a';
export const ACTION = 'deploy-release';
export const RESOURCE = 'cluster-eu-1';
export const ENCODED_RESOURCE = 'café/a b?x';
export const HOSTNAME = 'gateway.executor.example';
export const NONDEFAULT_PORT = 8443;
export const BEARER = 'G02C1AReferenceGatewayBearer0123456789';
export const BEARER_ENV = 'G02C1A_GATEWAY_TOKEN';
export const HEADER_CREDENTIAL_NAME = 'x-gateway-key';
export const HEADER_CREDENTIAL = 'G02C1AHeaderGatewayKey0123456789';
export const HEADER_CREDENTIAL_ENV = 'G02C1A_GATEWAY_KEY';
export const DIGEST_HEADER = 'frontera-executor-binding-digest';
export const LOOPBACK = Object.freeze({ address: '127.0.0.1', family: 4 as const });

// ── Keys: private halves stay in this process's memory, never on disk ───────

export interface TestKey {
  readonly keyId: string;
  readonly publicKeyPem: string;
  readonly privateKey: KeyObject;
}

function ed25519(keyId: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return Object.freeze({ keyId, publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey });
}

export const ISSUER_KEY = ed25519('g02c1a-issuer-key-1');
/** Pinned beside ISSUER_KEY: rotation overlap. */
export const ISSUER_ROTATED_KEY = ed25519('g02c1a-issuer-key-2');
export const OTHER_ISSUER_KEY = ed25519('g02c1a-other-issuer-key');
/** Never pinned anywhere. */
export const UNPINNED_KEY = ed25519('g02c1a-unpinned-key');

export const pin = (key: TestKey) => ({ keyId: key.keyId, algorithm: 'ed25519-v1', publicKeyPem: key.publicKeyPem });

// ── Executor configuration ──────────────────────────────────────────────────

export function executorConfiguration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'frontera.reference-executor-configuration.v1',
    environment: 'reference-synthetic',
    executorId: EXECUTOR_ID,
    audience: AUDIENCE,
    organizationIds: [ORGANIZATION],
    trustDomain: TRUST_DOMAIN,
    trustedIssuers: [
      { issuer: ISSUER, keys: [pin(ISSUER_KEY), pin(ISSUER_ROTATED_KEY)] },
      { issuer: OTHER_ISSUER, keys: [pin(OTHER_ISSUER_KEY)] },
    ],
    permittedActions: [ACTION, 'scale-release'],
    permittedResources: [RESOURCE, ENCODED_RESOURCE],
    bindingFormats: ['frontera.http-request-binding.v1'],
    expectedOrigin: `https://${HOSTNAME}`,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    clientCredential: { kind: 'bearer', tokenEnv: BEARER_ENV },
    maximumLifetimeMs: 60_000,
    maximumClockSkewMs: 5_000,
    statusPolicy: 'offline-only',
    listen: { host: '127.0.0.1', port: 0 },
    ...overrides,
  };
}

export const EXECUTOR_ENVIRONMENT: Readonly<Record<string, string>> = Object.freeze({ [BEARER_ENV]: BEARER, [HEADER_CREDENTIAL_ENV]: HEADER_CREDENTIAL });

// ── Host-like side: the real G-02C0 mapper and binding ──────────────────────

export const TYPED_PARAMETERS: readonly GovernedParameter[] = Object.freeze([
  Object.freeze({ dimension: 'replicaCount', type: 'integer', value: 4 } as GovernedParameter),
  Object.freeze({ dimension: 'strategy', type: 'token', value: 'rolling' } as GovernedParameter),
]);

export function validatedAction(overrides: Partial<Record<keyof ValidatedExecutionAction, unknown>> = {}): ValidatedExecutionAction {
  return Object.freeze({
    boundedGrantId: 'aoc.grant:g02c1a',
    subject: 'agent:release-bot',
    action: ACTION,
    resource: RESOURCE,
    counterparty: 'vendor-0042',
    organization: ORGANIZATION,
    amount: Object.freeze({ value: '7500', unit: 'USD' }),
    parameters: TYPED_PARAMETERS,
    notAfter: '2030-01-01T00:00:00.000Z',
    correlation: Object.freeze({ requestId: 'req-g02c1a', decisionId: 'dec-g02c1a', executionId: 'aoc.exec:g02c1a-0001' }),
    ...overrides,
  } as unknown as ValidatedExecutionAction);
}

export function hostOptions(overrides: Record<string, unknown> = {}): EnterpriseGenericHttpExecutionAdapterOptions {
  return {
    adapterId: 'g02c1a.executor-gateway',
    origin: `https://${HOSTNAME}`,
    method: 'POST',
    path: [
      { kind: 'literal', value: 'v1' },
      { kind: 'literal', value: 'deployments' },
      { kind: 'source', source: 'resource' },
    ],
    credential: { kind: 'bearer', token: BEARER },
    timeoutMs: 1000,
    ...overrides,
  } as EnterpriseGenericHttpExecutionAdapterOptions;
}

/** One Host-side request: what the real mapper built, and the digest the real G-02C0 binding gives it. */
export interface HostVector {
  readonly name: string;
  readonly plan: GenericHttpPlan;
  readonly request: GenericHttpWireRequest;
  readonly digest: string;
}

export function hostVector(name: string, options: Record<string, unknown> = {}, action: ValidatedExecutionAction = validatedAction()): HostVector {
  const plan = snapshotGenericHttpOptions(hostOptions(options));
  const mapped = mapGenericHttpRequest(plan, action);
  assert.ok(mapped.ok, `${name}: the Host mapper builds the request`);
  const digest = executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: genericHttpRequestBinding(plan, mapped.request) });
  return Object.freeze({ name, plan, request: mapped.request, digest });
}

export const digestOfRecord = (record: unknown): string => executionCapabilityActionBindingDigest({ format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, value: record });

// ── Capabilities and presentations (signed here, in the test) ───────────────

const iso = (ms: number): string => new Date(ms).toISOString();

export function capabilityFor(digest: string, overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}): ExecutionCapability {
  const now = Date.now();
  return {
    format: EXECUTION_CAPABILITY_FORMAT,
    capabilityId: randomBytes(32).toString('hex'),
    issuer: ISSUER,
    issuerKeyId: ISSUER_KEY.keyId,
    organizationId: ORGANIZATION,
    trustDomain: TRUST_DOMAIN,
    audience: AUDIENCE,
    subjectActorId: 'agent:release-bot',
    onBehalfOfActorId: null,
    action: ACTION,
    resource: RESOURCE,
    actionBinding: { format: GENERIC_HTTP_REQUEST_BINDING_FORMAT, digest },
    executionId: `aoc.exec:${randomBytes(16).toString('hex')}`,
    grantReference: `sha256:${'2'.repeat(64)}`,
    consumption: 'single-use',
    statusRequirement: 'offline-permitted',
    issuedAt: iso(now - 1_000),
    expiresAt: iso(now + 29_000),
    ...overrides,
  } as ExecutionCapability;
}

export function signatureOver(bytes: Buffer, key: TestKey, keyId: string = key.keyId) {
  return { algorithm: 'ed25519-v1', artifactVersion: AUTHORITY_ARTIFACT_VERSION, keyId, signature: sign(null, bytes, key.privateKey).toString('base64url') };
}

/** Every presentation this process produced, so a suite can prove none of them leaks into an executor's diagnostics. */
export const ISSUED_PRESENTATIONS: string[] = [];

/** The presentation header value for `capability`, signed by `key` over the real G-02A signing bytes. */
export function presentationFor(capability: ExecutionCapability, key: TestKey = ISSUER_KEY, keyId: string = key.keyId): string {
  const value = encodeExecutionCapabilityPresentation({
    capability: serializeExecutionCapability(capability),
    signature: signatureOver(executionCapabilitySigningBytes(capability), key, keyId),
    bindingFormat: capability.actionBinding.format,
  });
  ISSUED_PRESENTATIONS.push(value);
  return value;
}

/** A presentation encoded without the codec's checks — how an attacker would spell one. */
export function rawPresentation(envelope: unknown): string {
  return Buffer.from(canonicalSerialize(envelope), 'utf8').toString('base64url');
}

/** The request the Host will send in G-02C1D: the mapped request, plus the one presentation header. The binding stays over `request`. */
export function withPresentation(request: GenericHttpWireRequest, presentation: string): GenericHttpWireRequest {
  return Object.freeze({ ...request, headers: Object.freeze([...request.headers, Object.freeze([EXECUTION_CAPABILITY_PRESENTATION_HEADER, presentation] as const)]) });
}

// ── The Host's real transport, over plain HTTP to loopback ──────────────────

/** An agent that dials one loopback port whatever the request names, with no keep-alive — like the transport's `agent: false`. */
class LoopbackAgent extends Agent {
  constructor(private readonly targetPort: number) {
    super({ keepAlive: false });
  }

  override createConnection(): Socket {
    return connect({ host: '127.0.0.1', port: this.targetPort });
  }
}

/**
 * The request primitive `sendOnce` calls, with the exact options the Host
 * transport built, except: `http:` instead of `https:` (no TLS in CI), a
 * loopback agent, and `defaultPort: 443` so Node writes `Host` exactly as the
 * HTTPS transport would. Method, path, headers, body and `setHost` are untouched.
 */
export function loopbackPrimitive(port: number): GenericHttpRequestPrimitive {
  return (options, onResponse) => httpRequest({ ...options, protocol: 'http:', agent: new LoopbackAgent(port), defaultPort: 443 }, onResponse);
}

export function sendThroughHostTransport(port: number, request: GenericHttpWireRequest, readHeader: string | undefined = DIGEST_HEADER): Promise<GenericHttpTransportObservation> {
  return sendOnce(loopbackPrimitive(port), request, LOOPBACK, 5_000, readHeader);
}

/** The exact bytes the Host transport writes for `request`, captured by a loopback TCP listener that answers 409 and closes. */
export async function captureHostBytes(request: GenericHttpWireRequest): Promise<Buffer> {
  let resolveBytes: (bytes: Buffer) => void = () => undefined;
  const captured = new Promise<Buffer>((done) => {
    resolveBytes = done;
  });
  const server = createNetServer((socket) => {
    let bytes = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      const end = bytes.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = bytes.subarray(0, end).toString('latin1');
      const length = /\r\ncontent-length:\s*([0-9]+)/i.exec(head);
      if (bytes.length - (end + 4) < (length === null ? 0 : Number(length[1]))) return;
      resolveBytes(bytes);
      socket.end('HTTP/1.1 409 Conflict\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', () => ready()));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  try {
    const observation = await sendOnce(loopbackPrimitive(address.port), request, LOOPBACK, 5_000, undefined);
    assert.equal(observation.kind, 'response');
    return await captured;
  } finally {
    await new Promise<void>((closed) => server.close(() => closed()));
  }
}

// ── Raw HTTP/1.1 bytes ──────────────────────────────────────────────────────

export interface RawRequest {
  readonly requestLine: string;
  readonly headerLines: readonly string[];
  readonly body: Buffer;
}

export function parseRaw(bytes: Buffer): RawRequest {
  const end = bytes.indexOf('\r\n\r\n');
  assert.ok(end > 0);
  const lines = bytes.subarray(0, end).toString('latin1').split('\r\n');
  return Object.freeze({ requestLine: lines[0] ?? '', headerLines: Object.freeze(lines.slice(1)), body: Buffer.from(bytes.subarray(end + 4)) });
}

export function serializeRaw(raw: RawRequest): Buffer {
  return Buffer.concat([Buffer.from(`${[raw.requestLine, ...raw.headerLines].join('\r\n')}\r\n\r\n`, 'latin1'), raw.body]);
}

const nameOf = (line: string): string => line.slice(0, line.indexOf(':')).toLowerCase();

/** Every header line named `name` (case-insensitively) replaced by `replace(line)`, or removed when it returns `null`. */
export function editHeaders(raw: RawRequest, name: string, replace: (line: string) => string | null): RawRequest {
  return Object.freeze({ ...raw, headerLines: Object.freeze(raw.headerLines.map((line) => (nameOf(line) === name ? replace(line) : line)).filter((line): line is string => line !== null)) });
}

export function addHeaderLines(raw: RawRequest, ...lines: string[]): RawRequest {
  return Object.freeze({ ...raw, headerLines: Object.freeze([...raw.headerLines, ...lines]) });
}

export function headerValue(raw: RawRequest, name: string): string | undefined {
  const line = raw.headerLines.find((candidate) => nameOf(candidate) === name);
  return line === undefined ? undefined : line.slice(line.indexOf(':') + 1).trim();
}

/** A new body with its content-length line rewritten to the new length (lower-case name, as the mapper writes it). */
export function withBody(raw: RawRequest, body: Buffer): RawRequest {
  return Object.freeze({ ...editHeaders(raw, 'content-length', () => `content-length: ${String(body.length)}`), body });
}

/** The same request with a freshly issued presentation for `digest` (capabilities expire; a test can outlast one). */
export function withFreshPresentation(raw: RawRequest, digest: string, overrides: Partial<Record<keyof ExecutionCapability, unknown>> = {}, key: TestKey = ISSUER_KEY): RawRequest {
  const value = presentationFor(capabilityFor(digest, overrides), key);
  return editHeaders(raw, EXECUTION_CAPABILITY_PRESENTATION_HEADER, () => `${EXECUTION_CAPABILITY_PRESENTATION_HEADER}: ${value}`);
}

export interface RawResponse {
  readonly status: number | undefined;
  readonly head: string;
  readonly body: string;
}

/** Writes `bytes` to the executor on one fresh connection and reads until it closes. */
export function rawExchange(port: number, bytes: Buffer, timeoutMs = 8_000): Promise<RawResponse> {
  return new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port });
    let received = Buffer.alloc(0);
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      const text = received.toString('utf8');
      const split = text.indexOf('\r\n\r\n');
      const head = split === -1 ? text : text.slice(0, split);
      const status = /^HTTP\/1\.1 ([0-9]{3})/.exec(head);
      done({ status: status === null ? undefined : Number(status[1]), head, body: split === -1 ? '' : text.slice(split + 4) });
    };
    const timer = setTimeout(finish, timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    socket.on('close', finish);
    socket.on('error', () => undefined);
    socket.write(bytes);
  });
}

// ── The executor process ────────────────────────────────────────────────────

export const EXECUTOR_SCRIPT = resolve('scripts/run-reference-executor.mjs');
export const CONFIG_VARIABLE = 'FRONTERA_REFERENCE_EXECUTOR_CONFIG_FILE';

export interface SpawnedExecutor {
  readonly port: number;
  readonly pid: number;
  readonly configPath: string;
  /** Exactly the environment the child was started with. */
  readonly environment: Readonly<Record<string, string>>;
  /** The variable names the child itself reported seeing (its ready line). */
  readonly reportedEnvironment: readonly string[];
  readonly assessments: readonly ReferenceExecutorAssessment[];
  stdout(): string;
  stderr(): string;
  /** Resolves once at least `count` assessments have been reported. */
  waitForAssessments(count: number, timeoutMs?: number): Promise<void>;
  kill(): Promise<void>;
}

function configDirectory(config: Record<string, unknown>): { readonly dir: string; readonly path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-g02c1a-executor-'));
  const path = join(dir, 'executor.json');
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return { dir, path };
}

function childEnvironment(configPath: string, extra: Readonly<Record<string, string>>): Record<string, string> {
  // The executor's environment is its own: PATH, its configuration file and its credential variables. Nothing of a Host.
  return { PATH: process.env.PATH ?? '', [CONFIG_VARIABLE]: configPath, ...extra };
}

export async function spawnExecutor(config: Record<string, unknown> = executorConfiguration(), extra: Readonly<Record<string, string>> = EXECUTOR_ENVIRONMENT): Promise<SpawnedExecutor> {
  const { dir, path } = configDirectory(config);
  const environment = Object.freeze(childEnvironment(path, extra));
  const child: ChildProcess = spawn(process.execPath, [EXECUTOR_SCRIPT], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const assessments: ReferenceExecutorAssessment[] = [];
  const waiters: (() => void)[] = [];
  let out = '';
  let err = '';
  let buffered = '';
  let reportedEnvironment: readonly string[] = [];
  let ready: (port: number) => void = () => undefined;
  let failed: (error: Error) => void = () => undefined;
  const started = new Promise<number>((resolvePort, reject) => {
    ready = resolvePort;
    failed = reject;
  });
  const deadline = setTimeout(() => {
    child.kill('SIGKILL');
    failed(new Error(`reference executor did not start: ${err}`));
  }, 20_000);
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
    buffered += chunk.toString();
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      const event = JSON.parse(line) as { readonly event: string; readonly port?: number; readonly environment?: readonly string[] } & ReferenceExecutorAssessment;
      if (event.event === 'ready') {
        clearTimeout(deadline);
        reportedEnvironment = event.environment ?? [];
        ready(event.port as number);
      } else if (event.event === 'assessment') {
        const { event: _event, environment: _environment, ...assessment } = event;
        assessments.push(Object.freeze(assessment));
        for (const waiter of waiters.splice(0)) waiter();
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  child.on('exit', (code) => {
    clearTimeout(deadline);
    failed(new Error(`reference executor exited (${String(code)}): ${err}`));
  });
  const port = await started;
  return {
    port,
    pid: child.pid as number,
    configPath: path,
    environment,
    get reportedEnvironment() {
      return reportedEnvironment;
    },
    assessments,
    stdout: () => out,
    stderr: () => err,
    waitForAssessments: async (count, timeoutMs = 5_000) => {
      const limit = Date.now() + timeoutMs;
      while (assessments.length < count) {
        const remaining = limit - Date.now();
        assert.ok(remaining > 0, `expected ${count} assessments, saw ${assessments.length}`);
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            wake();
          });
        });
      }
    },
    kill: () =>
      new Promise<void>((done) => {
        const cleanup = (): void => {
          rmSync(dir, { recursive: true, force: true });
          done();
        };
        if (child.exitCode !== null || child.signalCode !== null) return cleanup();
        child.once('exit', cleanup);
        child.kill('SIGKILL');
      }),
  };
}

/** Starts the executor with a configuration it must refuse, and returns its refusal line. */
export async function refusedStart(config: Record<string, unknown>, extra: Readonly<Record<string, string>> = EXECUTOR_ENVIRONMENT): Promise<{ readonly code: number | null; readonly refusal: { readonly event: string; readonly code: string; readonly message: string }; readonly stdout: string; readonly stderr: string }> {
  const { dir, path } = configDirectory(config);
  try {
    const child = spawn(process.execPath, [EXECUTOR_SCRIPT], { env: childEnvironment(path, extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
      child.on('exit', (exitCode) => {
        clearTimeout(timer);
        done(exitCode);
      });
    });
    return { code, refusal: JSON.parse(err.trim().split('\n').pop() ?? '{}') as { event: string; code: string; message: string }, stdout: out, stderr: err };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sends `bytes`, then returns the response and the one assessment the executor reported for it. */
export async function exchange(executor: SpawnedExecutor, bytes: Buffer): Promise<{ readonly response: RawResponse; readonly assessment: ReferenceExecutorAssessment }> {
  const before = executor.assessments.length;
  const response = await rawExchange(executor.port, bytes);
  await executor.waitForAssessments(before + 1);
  return { response, assessment: executor.assessments[before] as ReferenceExecutorAssessment };
}

// ── In-process observed requests (for the pipeline's own unit tests) ────────

/**
 * What Node's server would hand the gateway for `request` as the Host
 * transport writes it: `Host`, `Connection: close`, the mapped headers, and
 * `Content-Length: 0` for a body-less POST, PUT or PATCH. The separate-process
 * suite checks this against real bytes; this is only for fast in-process tests.
 */
export function observedFor(request: GenericHttpWireRequest, authority: string = HOSTNAME): ObservedHttpRequest {
  const raw: string[] = [];
  for (const [name, value] of request.headers) raw.push(name, value);
  raw.push('Host', authority);
  if (request.body === undefined && request.method !== 'DELETE') raw.push('Content-Length', '0');
  raw.push('Connection', 'close');
  return { httpVersion: '1.1', method: request.method, target: request.path, rawHeaders: raw, body: Buffer.from(request.body ?? '', 'utf8') };
}

export interface ObservedOptions {
  readonly capability?: Partial<Record<keyof ExecutionCapability, unknown>>;
  readonly key?: TestKey;
  /** A presentation header value to send instead of a fresh one. */
  readonly presentation?: string;
  readonly edit?: (raw: string[]) => string[];
  readonly httpVersion?: string;
  readonly method?: string;
  readonly target?: string;
  readonly body?: Buffer;
  readonly authority?: string;
}

/** An observed request for `vector`, presented with a fresh capability for its own digest unless told otherwise. */
export function observedWith(vector: HostVector, options: ObservedOptions = {}): ObservedHttpRequest {
  const presentation = options.presentation ?? presentationFor(capabilityFor(vector.digest, options.capability ?? {}), options.key ?? ISSUER_KEY);
  const base = observedFor(withPresentation(vector.request, presentation), options.authority ?? HOSTNAME);
  const rawHeaders = options.edit === undefined ? [...base.rawHeaders] : options.edit([...base.rawHeaders]);
  return { httpVersion: options.httpVersion ?? base.httpVersion, method: options.method ?? base.method, target: options.target ?? base.target, rawHeaders, body: options.body ?? base.body };
}

/** Every raw header named `name` (case-insensitively) given `value`. */
export function setRawHeader(raw: readonly string[], name: string, value: string): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) out.push(raw[index] as string, (raw[index] as string).toLowerCase() === name ? value : (raw[index + 1] as string));
  return out;
}

export function dropRawHeader(raw: readonly string[], name: string): string[] {
  const out: string[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) if ((raw[index] as string).toLowerCase() !== name) out.push(raw[index] as string, raw[index + 1] as string);
  return out;
}

export const addRawHeader = (raw: readonly string[], name: string, value: string): string[] => [...raw, name, value];
