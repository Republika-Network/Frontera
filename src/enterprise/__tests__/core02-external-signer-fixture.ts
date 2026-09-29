import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { AuthoritySignature } from '../authority-authenticity/authority-signature.js';
import type { AuthorityArtifactSigner } from '../authority-authenticity/signer.js';
import {
  ExternalAuthoritySignerTransportError,
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
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
