import { createHash, generateKeyPairSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { boundedGrantDigestMatches, isWellFormedBoundedGrantSemantics, type BoundedGrant } from '../../../features/grant-runtime/index.js';
import { AUTHORITY_ARTIFACT_VERSION, type AuthoritySignature } from '../../authority-authenticity/authority-signature.js';
import { authorityVerificationKeyFromPrivateKey, createSoftwareAuthorityArtifactSigner } from '../../authority-authenticity/signer.js';
import { parseStoredGrant } from '../../bounded-grant-store/sqlite-bounded-grant-store.js';
import {
  EXTERNAL_AUTHORITY_SIGNER_OPERATIONS,
  EXTERNAL_AUTHORITY_SIGNER_PATHS,
  EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
  parseExternalSigningRequest,
  type ExternalAuthoritySignerOperation,
  type ExternalAuthoritySigningRequest,
} from '../protocol.js';

/**
 * The **reference external custody service** for Frontera authority signing
 * (CORE-02) — a local, separate-process signer emulator.
 *
 * What it is: a small HTTP service, run as its **own process**, that holds the
 * authority private key and answers `frontera.external-authority-signer.v1`.
 * The Frontera Host talks to it over the network and never receives, derives or
 * forwards the key. It exists to prove the architecture — that a production
 * Host can run all five authority operations with no private key in its
 * address space — and as the reference for a real custody adapter.
 *
 * What it is **not**: an HSM, a KMS, or hardware-backed. Its key is an
 * ordinary PKCS#8 file readable by this process. It binds loopback only, speaks
 * plain HTTP, and authenticates its caller with one bearer credential. Nothing
 * about it is a deployment recommendation.
 *
 * Why it signs through `createSoftwareAuthorityArtifactSigner`: that keeps the
 * one place a private key is parsed (`authority-authenticity/signer.ts`) the
 * one place, and it means this service can only perform the five structured,
 * domain-separated operations — there is no route, and no code path, that signs
 * caller-chosen bytes. Every request is parsed strictly into the artifact its
 * operation names (a grant must round-trip its canonical bytes and carry a
 * matching digest) before anything is signed.
 *
 * What it does not enforce: *policy*. A caller holding the credential can ask
 * for a signature over any well-formed artifact — which is exactly why the
 * credential is a secret, and why external custody narrows process compromise
 * (the key cannot be extracted) without making it harmless (an attacker in the
 * Host can still ask). A production custody service may add independent
 * authorization; this reference does not claim to.
 */

export interface ReferenceAuthoritySignerServiceOptions {
  readonly keyId: string;
  /** PKCS#8 PEM. Held by this service process only. */
  readonly privateKeyPem: string;
  /** The bearer credential callers must present. */
  readonly credential: string;
}

export interface ReferenceAuthoritySignerService {
  handle(req: IncomingMessage, res: ServerResponse): void;
  /** How many signatures each operation has produced. Counts only. */
  operationCounts(): Readonly<Record<ExternalAuthoritySignerOperation, number>>;
  readonly publicKeyPem: string;
}

const MAXIMUM_REQUEST_BYTES = 256 * 1024;

/** A grant is signed only if it round-trips its canonical bytes exactly, carries a matching digest and a well-formed semantic marker — the same checks a store's read path makes. */
function parseSignableGrant(canonical: string): BoundedGrant | undefined {
  const grant = parseStoredGrant(canonical);
  return grant !== undefined && boundedGrantDigestMatches(grant) && isWellFormedBoundedGrantSemantics(grant) ? grant : undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

export function createReferenceAuthoritySignerService(options: ReferenceAuthoritySignerServiceOptions): ReferenceAuthoritySignerService {
  if (typeof options.credential !== 'string' || options.credential.length < 32) throw new Error('The reference authority signer needs a credential of at least 32 characters.');
  const signer = createSoftwareAuthorityArtifactSigner({ keyId: options.keyId, algorithm: 'ed25519-v1', privateKeyPem: options.privateKeyPem });
  const publicKeyPem = authorityVerificationKeyFromPrivateKey(options.privateKeyPem);
  const expected = digest(`Bearer ${options.credential}`);
  const counts = new Map<ExternalAuthoritySignerOperation, number>(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.map((operation) => [operation, 0]));
  const byPath = new Map<string, ExternalAuthoritySignerOperation>(EXTERNAL_AUTHORITY_SIGNER_OPERATIONS.map((operation) => [EXTERNAL_AUTHORITY_SIGNER_PATHS[operation], operation]));

  const identity = Object.freeze({
    protocol: EXTERNAL_AUTHORITY_SIGNER_PROTOCOL,
    keyId: signer.activeKeyId,
    algorithm: signer.algorithm,
    publicKeyPem,
    artifactVersion: AUTHORITY_ARTIFACT_VERSION,
    operations: [...EXTERNAL_AUTHORITY_SIGNER_OPERATIONS],
  });

  function authenticated(req: IncomingMessage): boolean {
    const presented = req.headers.authorization;
    // Compared as fixed-width digests, so timing reveals neither length nor prefix.
    return typeof presented === 'string' && timingSafeEqual(digest(presented), expected);
  }

  function signFor(request: ExternalAuthoritySigningRequest): Promise<AuthoritySignature> {
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

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!authenticated(req)) {
      req.resume();
      send(res, 401, { error: 'unauthenticated' });
      return;
    }
    if (path === EXTERNAL_AUTHORITY_SIGNER_PATHS.identity) {
      req.resume();
      if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
      return send(res, 200, identity);
    }
    const operation = byPath.get(path);
    if (operation === undefined) {
      req.resume();
      return send(res, 404, { error: 'not-found' });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'method-not-allowed' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAXIMUM_REQUEST_BYTES && !aborted) {
        aborted = true;
        send(res, 413, { error: 'too-large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'not-json' });
      }
      const request = parseExternalSigningRequest(operation, body, parseSignableGrant);
      if (request === undefined) return send(res, 422, { error: 'not-a-well-formed-artifact' });
      signFor(request).then(
        (signature) => {
          counts.set(operation, (counts.get(operation) ?? 0) + 1);
          send(res, 200, { signature });
        },
        () => send(res, 500, { error: 'signing-failed' }),
      );
    });
  }

  return Object.freeze({
    handle,
    publicKeyPem,
    operationCounts: () => Object.freeze(Object.fromEntries(counts)) as Readonly<Record<ExternalAuthoritySignerOperation, number>>,
  });
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Starts the reference service on a loopback address. Refuses any other bind:
 * this is a reference custody boundary, and plain HTTP beyond loopback is not
 * something it offers.
 *
 * A diagnostics route, `GET /v1/diagnostics/operations` (authenticated),
 * returns how many signatures each operation produced — counts only — so a
 * qualification can assert exactly which operations crossed the boundary.
 */
export async function startReferenceAuthoritySigner(
  options: ReferenceAuthoritySignerServiceOptions & { readonly host?: string; readonly port?: number },
): Promise<{ readonly server: Server; readonly port: number; readonly publicKeyPem: string; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error('The reference authority signer binds loopback only.');
  const service = createReferenceAuthoritySignerService(options);
  const server = createServer((req, res) => {
    if ((req.url ?? '').split('?')[0] === '/v1/diagnostics/operations') {
      req.resume();
      const presented = req.headers.authorization;
      if (typeof presented !== 'string' || !timingSafeEqual(digest(presented), digest(`Bearer ${options.credential}`))) return send(res, 401, { error: 'unauthenticated' });
      return send(res, 200, service.operationCounts());
    }
    service.handle(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    publicKeyPem: service.publicKeyPem,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Loads the service's key from `path`, or — when the file does not exist —
 * generates a fresh Ed25519 key there (mode 0600, never overwriting) and writes
 * its **public** half beside it as `<path>.pub` for the operator to install in
 * the Host's trusted verification registry out of band. The private file is
 * this service's alone; nothing in Frontera reads it.
 */
export function loadOrCreateReferenceSignerKey(path: string): { readonly privateKeyPem: string; readonly publicKeyPem: string } {
  if (!existsSync(path)) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${path}.pub`, publicKey.export({ type: 'spki', format: 'pem' }).toString(), { mode: 0o644, flag: 'w' });
  }
  const privateKeyPem = readFileSync(path, 'utf8');
  return { privateKeyPem, publicKeyPem: authorityVerificationKeyFromPrivateKey(privateKeyPem) };
}
