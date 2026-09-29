import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import {
  ExternalAuthoritySignerTransportError,
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
  EXTERNAL_AUTHORITY_SIGNER_PATHS,
  EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
  createHttpExternalAuthoritySignerTransport,
  establishExternalAuthorityArtifactSigner,
  type ExternalAuthorityArtifactSigner,
  type ExternalAuthoritySignerOperation,
  type ExternalAuthoritySignerTransport,
  type ExternalAuthoritySigningRequest,
} from '../external-authority-signer/index.js';
import { startReferenceAuthoritySigner } from '../external-authority-signer/reference/reference-signer-service.js';
import { AUTHORITY_ARTIFACT_VERSION } from '../authority-authenticity/authority-signature.js';
import { testSigner, testVerifier, trustedKeyOf, type TestAuthorityKey } from './authority-authenticity-fixture.js';

/**
 * CORE-02 — the external custody boundary, for tests.
 *
 * Three shapes, used for different claims:
 *
 * - `startInProcessSigner` — the reference custody service in **this** process,
 *   over real loopback HTTP. For protocol, handshake, timeout and store
 *   semantics. It proves nothing about key residency, and no test that uses it
 *   claims to.
 * - `ScriptedTransport` — the service's answers under the test's control, for
 *   the malicious-signer matrix: it can answer with the genuine signature, a
 *   substituted one, garbage, a hang or an error.
 * - `spawnReferenceSigner` — the reference service as a **separate process**,
 *   launched through `scripts/run-reference-authority-signer.mjs` with its own
 *   environment and its own key file. The test process reads only the key
 *   file's public half (`<file>.pub`) — the out-of-band step an operator takes
 *   to install trust. This is the shape the process-isolation claims rest on.
 */

export const SIGNER_TOKEN = 'FRONTERA_CORE02_SIGNER_TOKEN_SENTINEL_9f3a61c2d8b7e054';

export async function startInProcessSigner(key: TestAuthorityKey, credential = SIGNER_TOKEN): Promise<{ readonly endpoint: string; close(): Promise<void>; counts(): Promise<Record<string, number>> }> {
  const service = await startReferenceAuthoritySigner({ keyId: key.keyId, privateKeyPem: key.privateKeyPem, credential });
  const endpoint = `http://127.0.0.1:${service.port}`;
  return { endpoint, close: () => service.close(), counts: () => operationCounts(endpoint, credential) };
}

/** An external signer established against `endpoint`, pinned to `pin` and trusting `trust`. */
export function establish(
  endpoint: string,
  options: { readonly pin: TestAuthorityKey; readonly trust?: readonly TestAuthorityKey[]; readonly timeoutMs?: number; readonly maxAttempts?: number; readonly credential?: string } ,
): Promise<ExternalAuthorityArtifactSigner> {
  const verifier = testVerifier(options.trust ?? [options.pin]);
  return establishExternalAuthorityArtifactSigner({
    transport: createHttpExternalAuthoritySignerTransport({ endpoint, credential: options.credential ?? SIGNER_TOKEN }),
    pinned: trustedKeyOf(options.pin),
    verifier,
    timeoutMs: options.timeoutMs ?? 2_000,
    maxAttempts: options.maxAttempts ?? 1,
  });
}

export function identityOf(key: TestAuthorityKey, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
    keyId: key.keyId,
    algorithm: key.algorithm,
    publicKeyPem: key.publicKeyPem,
    artifactVersion: AUTHORITY_ARTIFACT_VERSION,
    operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS],
    ...overrides,
  };
}

/** The genuine answer a software signer holding `key` would give to `request`. */
export async function genuineSignature(key: TestAuthorityKey, request: ExternalAuthoritySigningRequest): Promise<AuthoritySignature> {
  return signWith(testSigner(key), request);
}

export function signWith(signer: AuthorityArtifactSigner, request: ExternalAuthoritySigningRequest): Promise<AuthoritySignature> {
  switch (request.operation) {
    case 'signGrant':
      return signer.signGrant(request.grant, request.storeId);
    case 'signRevocation':
      return signer.signRevocation(request.revocation, request.storeId);
    case 'signRevocationState':
      return signer.signRevocationState(request.state);
    case 'signObligationDischargeState':
      return signer.signObligationDischargeState(request.state);
    case 'signApprovalState':
      return signer.signApprovalState(request.state);
  }
}

export type Answer = (request: ExternalAuthoritySigningRequest, attempt: number) => unknown | Promise<unknown>;

/**
 * A transport whose answers the test scripts. By default it behaves like a
 * genuine custody service holding `key`. Every call is recorded.
 */
export class ScriptedTransport implements ExternalAuthoritySignerTransport {
  readonly signCalls: ExternalAuthoritySignerOperation[] = [];
  identityCalls = 0;
  identityAnswer: () => unknown = () => identityOf(this.key);
  answer: Answer;

  constructor(private readonly key: TestAuthorityKey) {
    this.answer = async (requestToSign) => ({ signature: await genuineSignature(key, requestToSign) });
  }

  async identity(): Promise<unknown> {
    this.identityCalls += 1;
    return this.identityAnswer();
  }

  async sign(requestToSign: ExternalAuthoritySigningRequest): Promise<unknown> {
    this.signCalls.push(requestToSign.operation);
    const attempt = this.signCalls.length;
    return this.answer(requestToSign, attempt);
  }

  count(operation: ExternalAuthoritySignerOperation): number {
    return this.signCalls.filter((entry) => entry === operation).length;
  }
}

export const unavailable = (reason: ConstructorParameters<typeof ExternalAuthoritySignerTransportError>[0] = 'EXTERNAL_SIGNER_UNREACHABLE') => {
  throw new ExternalAuthoritySignerTransportError(reason, `scripted ${reason}`);
};

/** An external signer over a scripted transport. */
export function establishScripted(
  transport: ScriptedTransport,
  options: { readonly pin: TestAuthorityKey; readonly trust?: readonly TestAuthorityKey[]; readonly maxAttempts?: number; readonly timeoutMs?: number },
): Promise<ExternalAuthorityArtifactSigner> {
  return establishExternalAuthorityArtifactSigner({
    transport,
    pinned: trustedKeyOf(options.pin),
    verifier: testVerifier(options.trust ?? [options.pin]),
    timeoutMs: options.timeoutMs ?? 1_000,
    maxAttempts: options.maxAttempts ?? 1,
  });
}

// ── the separate-process reference signer ────────────────────────────────────

const SIGNER_SCRIPT = resolve('scripts/run-reference-authority-signer.mjs');

export interface SpawnedSigner {
  readonly keyId: string;
  readonly keyFile: string;
  readonly port: number;
  readonly endpoint: string;
  readonly pid: number;
  /** The **public** key the signer wrote beside its key file — what an operator installs out of band. */
  readonly publicKeyPem: string;
  readonly child: ChildProcess;
  /** SIGKILL: an abrupt outage, not a graceful shutdown. */
  kill(): Promise<void>;
  counts(): Promise<Record<string, number>>;
}

/** A private directory for a signer's key file. The test process never reads the private key in it. */
export function signerKeyDirectory(): { readonly dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'frontera-core02-signer-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function spawnReferenceSigner(options: { readonly keyFile: string; readonly keyId: string; readonly port?: number; readonly credential?: string }): Promise<SpawnedSigner> {
  const credential = options.credential ?? SIGNER_TOKEN;
  // The signer's environment is its own: PATH plus its four variables. Nothing
  // of the Host's configuration, and the Host is never given any of this.
  const child = spawn(process.execPath, [SIGNER_SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '',
      FRONTERA_REFERENCE_SIGNER_KEY_FILE: options.keyFile,
      FRONTERA_REFERENCE_SIGNER_KEY_ID: options.keyId,
      FRONTERA_REFERENCE_SIGNER_TOKEN: credential,
      FRONTERA_REFERENCE_SIGNER_PORT: String(options.port ?? 0),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let out = '';
    let err = '';
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`reference signer did not start: ${err}`));
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (match !== null) {
        clearTimeout(deadline);
        resolvePort(Number.parseInt(match[1] as string, 10));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`reference signer exited (${String(code)}): ${err}`));
    });
  });
  const endpoint = `http://127.0.0.1:${port}`;
  return {
    keyId: options.keyId,
    keyFile: options.keyFile,
    port,
    endpoint,
    pid: child.pid as number,
    publicKeyPem: readFileSync(`${options.keyFile}.pub`, 'utf8'),
    child,
    kill: () =>
      new Promise<void>((resolveKill) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolveKill();
        child.once('exit', () => resolveKill());
        child.kill('SIGKILL');
      }),
    counts: () => operationCounts(endpoint, credential),
  };
}

export function operationCounts(endpoint: string, credential = SIGNER_TOKEN): Promise<Record<string, number>> {
  return new Promise((resolveCounts, reject) => {
    const req = request(new URL('/v1/diagnostics/operations', endpoint), { method: 'GET', agent: false, headers: { authorization: `Bearer ${credential}` } }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on('end', () => {
        try {
          resolveCounts(JSON.parse(body) as Record<string, number>);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * The environment a Host needs for external custody — endpoint, credential, the pinned key id and the trusted public keys. No private key.
 * The probe interval is 0 so every `/health` probes identity: these suites assert that an outage is visible on the next health check.
 * The default interval (and the fanout bound it buys) is qualified in `external-authority-signer-review-hardening.test.ts`.
 */
export function externalCustodyEnv(signer: { readonly endpoint: string; readonly keyId: string }, trusted: readonly { readonly keyId: string; readonly algorithm: string; readonly publicKeyPem: string }[], extra: Record<string, string> = {}): Record<string, string> {
  return {
    AOC_ENTERPRISE_AUTHORITY_SIGNER_MODE: 'external',
    AOC_ENTERPRISE_AUTHORITY_SIGNER_ENDPOINT: signer.endpoint,
    AOC_ENTERPRISE_AUTHORITY_SIGNER_TOKEN: SIGNER_TOKEN,
    AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: signer.keyId,
    AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: JSON.stringify(trusted),
    AOC_ENTERPRISE_AUTHORITY_SIGNER_TIMEOUT_MS: '2000',
    AOC_ENTERPRISE_AUTHORITY_SIGNER_MAX_ATTEMPTS: '1',
    AOC_ENTERPRISE_AUTHORITY_SIGNER_PROBE_INTERVAL_MS: '0',
    ...extra,
  };
}

/** Removes every software-custody variable from an environment built by an older fixture. */
export function withoutSoftwareCustody(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const { AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_ID: _id, AOC_ENTERPRISE_AUTHORITY_SIGNING_KEY_PEM: _pem, AOC_ENTERPRISE_AUTHORITY_VERIFICATION_KEYS: _keys, ...rest } = env;
  void _id;
  void _pem;
  void _keys;
  return rest;
}

// ── a fault-injecting proxy in front of a custody service (CORE-02R) ──────────

/** What the proxy does to signing calls. Identity calls always pass through to `identityTarget`. */
export type SigningFault = 'pass' | 'unavailable' | 'hang' | 'redirect';

export interface FaultProxy {
  readonly endpoint: string;
  /** How signing requests are answered from now on. `redirect` forwards them to `redirectTarget`. */
  fault: SigningFault;
  redirectTarget: string | undefined;
  identityCalls: number;
  signCalls: number;
  /** Inbound requests refused locally (unknown path, wrong method) — each made zero upstream requests. */
  readonly refused: number;
  close(): Promise<void>;
}

/** One protocol route the proxy may forward: the method and the canonical path, both server-owned constants. */
interface ProxyRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly signing: boolean;
}

/**
 * The closed route table, built from the protocol's own declared paths
 * (`EXTERNAL_AUTHORITY_SIGNER_PATHS`): `GET /v1/identity` and `POST` on each of
 * the five signing paths. Nothing else is ever forwarded.
 */
const PROXY_ROUTES: readonly ProxyRoute[] = Object.freeze(
  (Object.keys(EXTERNAL_AUTHORITY_SIGNER_PATHS) as (keyof typeof EXTERNAL_AUTHORITY_SIGNER_PATHS)[]).map((operation) =>
    Object.freeze({ method: operation === 'identity' ? ('GET' as const) : ('POST' as const), path: EXTERNAL_AUTHORITY_SIGNER_PATHS[operation], signing: operation !== 'identity' }),
  ),
);

/**
 * Resolves an inbound request-target to a route of the closed table by
 * **exact** string equality, so a query, a fragment, an absolute-form or
 * scheme-relative target, a dot-segment or any unknown path matches nothing.
 * The route returned carries the table's own constant path: the inbound string
 * never reaches an outbound URL.
 */
function resolveProxyRoute(requestTarget: string | undefined): ProxyRoute | undefined {
  return PROXY_ROUTES.find((route) => route.path === requestTarget);
}

/** Forwards to `target` (a fixture-owned base URL) at the route's constant method and path. */
function forward(target: string, route: ProxyRoute, headers: Record<string, string>, body: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolveForward, reject) => {
    const req = request(new URL(route.path, target), { method: route.method, agent: false, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolveForward({ status: res.statusCode ?? 502, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body.length > 0 ? body : undefined);
  });
}

/**
 * A loopback proxy that answers `GET /v1/identity` from the genuine service
 * (always healthy) while signing requests are passed, refused with 503, left
 * hanging, or redirected to another service. It separates "the identity
 * endpoint is reachable" from "signing works" — the distinction the health
 * model must keep.
 *
 * It forwards only the six protocol routes, each with its protocol method, to
 * `identityTarget` or (for signing under the `redirect` fault) the
 * test-controlled `redirectTarget`. An unknown request-target is refused with
 * 404 and a known path with the wrong method with 405, locally, with no
 * upstream request: an inbound request can never choose, or change, where the
 * proxy connects.
 */
export async function startFaultProxy(identityTarget: string): Promise<FaultProxy> {
  const hanging: import('node:http').ServerResponse[] = [];
  const state = { fault: 'pass' as SigningFault, redirectTarget: undefined as string | undefined, identityCalls: 0, signCalls: 0, refused: 0 };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const route = resolveProxyRoute(req.url);
      if (route === undefined) {
        state.refused += 1;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not a protocol route"}');
        return;
      }
      if (req.method !== route.method) {
        state.refused += 1;
        res.writeHead(405, { 'content-type': 'application/json', allow: route.method });
        res.end('{"error":"method not allowed"}');
        return;
      }
      const headers: Record<string, string> = {};
      for (const name of ['authorization', 'accept', 'content-type']) {
        const value = req.headers[name];
        if (typeof value === 'string') headers[name] = value;
      }
      const body = Buffer.concat(chunks);
      if (body.length > 0) headers['content-length'] = String(body.length);
      if (route.signing) state.signCalls += 1;
      else state.identityCalls += 1;
      if (route.signing && state.fault === 'unavailable') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"unavailable"}');
        return;
      }
      if (route.signing && state.fault === 'hang') {
        hanging.push(res);
        return;
      }
      const target = route.signing && state.fault === 'redirect' && state.redirectTarget !== undefined ? state.redirectTarget : identityTarget;
      forward(target, route, headers, body).then(
        (answer) => {
          res.writeHead(answer.status, { 'content-type': 'application/json' });
          res.end(answer.body);
        },
        () => {
          res.writeHead(502);
          res.end();
        },
      );
    });
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const proxy: FaultProxy = {
    endpoint: `http://127.0.0.1:${port}`,
    get fault() {
      return state.fault;
    },
    set fault(value: SigningFault) {
      state.fault = value;
    },
    get redirectTarget() {
      return state.redirectTarget;
    },
    set redirectTarget(value: string | undefined) {
      state.redirectTarget = value;
    },
    get identityCalls() {
      return state.identityCalls;
    },
    set identityCalls(value: number) {
      state.identityCalls = value;
    },
    get signCalls() {
      return state.signCalls;
    },
    set signCalls(value: number) {
      state.signCalls = value;
    },
    get refused() {
      return state.refused;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const res of hanging.splice(0)) res.destroy();
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
  return proxy;
}
