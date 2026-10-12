import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Wallet } from 'xrpl';

import { EXTERNAL_XRPL_SIGNER_OPERATION, EXTERNAL_XRPL_SIGNER_PATHS, EXTERNAL_XRPL_SIGNER_PROTOCOL, isExternalXrplSignerId, parseExternalXrplSigningRequest } from '../signer-protocol.js';

/**
 * PAY-03 — the **reference** external XRPL transaction signer.
 *
 * NOT an HSM, NOT a KMS, NOT hardware-backed, and NOT a custody
 * recommendation. A separate process that holds one XRPL key in a file
 * (mode 0600, its alone) and answers `frontera.external-xrpl-transaction-signer.v1`,
 * for development and for production-shaped **Testnet** qualification: it lets
 * the Host be qualified with no XRPL key anywhere in the Host process.
 *
 * - It signs exactly one shape of transaction: the XRPL `Payment` PAY-02
 *   prepares, for its one account (`parseExternalXrplSigningRequest` refuses
 *   anything else before the key is touched). No raw-byte signing, no other
 *   transaction type, no key export route.
 * - It never connects to XRPL and never submits anything: it imports no client.
 * - It decides nothing. Governance happened in the Host; the signer's only
 *   access control is its bearer credential.
 * - Plain HTTP, loopback only.
 *
 * Never composed into the Host: the Host reaches it only over the protocol,
 * by endpoint (structurally tested).
 */
export interface ReferenceXrplSignerOptions {
  readonly signerId: string;
  /** The family seed the reference key is derived from. Read from this service's own key file; never from the Host. */
  readonly seed: string;
  readonly credential: string;
}

const MAXIMUM_REQUEST_BYTES = 64 * 1024;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'cache-control': 'no-store' });
  res.end(payload);
}

export interface ReferenceXrplSignerService {
  handle(req: IncomingMessage, res: ServerResponse): void;
  readonly address: string;
  readonly signingPublicKey: string;
  /** Signatures produced. A count only. */
  signatures(): number;
}

export function createReferenceXrplSignerService(options: ReferenceXrplSignerOptions): ReferenceXrplSignerService {
  if (!isExternalXrplSignerId(options.signerId)) throw new Error('The reference XRPL signer needs a recordable signer id.');
  if (typeof options.credential !== 'string' || options.credential.length < 32 || /\s/.test(options.credential)) throw new Error('The reference XRPL signer needs a credential of at least 32 characters without whitespace.');
  let wallet: Wallet;
  try {
    wallet = Wallet.fromSeed(options.seed);
  } catch {
    throw new Error('The reference XRPL signer key file does not hold a valid key.');
  }
  const expected = digest(`Bearer ${options.credential}`);
  const identity = Object.freeze({
    protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL,
    signerId: options.signerId,
    operations: [EXTERNAL_XRPL_SIGNER_OPERATION],
    accounts: [{ address: wallet.classicAddress, signingPublicKey: wallet.publicKey }],
  });
  let signatures = 0;

  const authenticated = (req: IncomingMessage): boolean => {
    const presented = req.headers.authorization;
    return typeof presented === 'string' && timingSafeEqual(digest(presented), expected);
  };

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (!authenticated(req)) {
      req.resume();
      return send(res, 401, { error: 'unauthenticated' });
    }
    if (path === EXTERNAL_XRPL_SIGNER_PATHS.identity) {
      req.resume();
      return req.method === 'GET' ? send(res, 200, identity) : send(res, 405, { error: 'method-not-allowed' });
    }
    if (path !== EXTERNAL_XRPL_SIGNER_PATHS.signPayment) {
      req.resume();
      return send(res, 404, { error: 'not-found' });
    }
    if (req.method !== 'POST') {
      req.resume();
      return send(res, 405, { error: 'method-not-allowed' });
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on('data', (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > MAXIMUM_REQUEST_BYTES) {
        refused = true;
        send(res, 413, { error: 'too-large' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (refused) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return send(res, 400, { error: 'not-json' });
      }
      const request = parseExternalXrplSigningRequest(body);
      // Exactly a PAY-02 Payment, for this signer and this account — or the key is never touched.
      if (request === undefined || request.signerId !== options.signerId || request.account !== wallet.classicAddress) return send(res, 422, { error: 'not-signable' });
      try {
        const { tx_blob, hash } = wallet.sign({ ...request.transaction, Amount: { ...request.transaction.Amount } });
        signatures += 1;
        return send(res, 200, { protocol: EXTERNAL_XRPL_SIGNER_PROTOCOL, signerId: options.signerId, requestId: request.requestId, account: wallet.classicAddress, signedTransaction: tx_blob, hash });
      } catch {
        return send(res, 500, { error: 'signing-failed' });
      }
    });
  }

  return Object.freeze({ handle, address: wallet.classicAddress, signingPublicKey: wallet.publicKey, signatures: () => signatures });
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/** Starts the reference service on a loopback address; any other bind is refused. */
export async function startReferenceXrplSigner(
  options: ReferenceXrplSignerOptions & { readonly host?: string; readonly port?: number },
): Promise<{ readonly server: Server; readonly port: number; readonly address: string; readonly signingPublicKey: string; signatures(): number; close(): Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopback(host)) throw new Error('The reference XRPL signer binds loopback only.');
  const service = createReferenceXrplSignerService(options);
  const server = createServer((req, res) => service.handle(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  return {
    server,
    port: (server.address() as AddressInfo).port,
    address: service.address,
    signingPublicKey: service.signingPublicKey,
    signatures: service.signatures,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const REFERENCE_XRPL_SIGNER_KEY_FILE_FORMAT = 'frontera.reference-xrpl-signer-key.v1';

/**
 * Loads the reference key from `path`, or — when absent — generates a fresh
 * one there (mode 0600, never overwriting) and writes its **public** identity
 * to `<path>.pub` (address + signing public key) for the operator to pin in the
 * Host's configuration. The private file is this service's alone.
 */
export function loadOrCreateReferenceXrplSignerKey(path: string): { readonly seed: string; readonly address: string; readonly signingPublicKey: string } {
  if (!existsSync(path)) {
    const wallet = Wallet.generate();
    writeFileSync(path, JSON.stringify({ format: REFERENCE_XRPL_SIGNER_KEY_FILE_FORMAT, seed: wallet.seed }), { mode: 0o600, flag: 'wx' });
    writeFileSync(`${path}.pub`, `${JSON.stringify({ address: wallet.classicAddress, signingPublicKey: wallet.publicKey })}\n`, { mode: 0o644, flag: 'w' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('The reference XRPL signer key file is not readable JSON.');
  }
  const record = parsed as { readonly format?: unknown; readonly seed?: unknown } | null;
  if (record?.format !== REFERENCE_XRPL_SIGNER_KEY_FILE_FORMAT || typeof record.seed !== 'string') throw new Error('The reference XRPL signer key file is not in the reference format.');
  const wallet = Wallet.fromSeed(record.seed);
  return { seed: record.seed, address: wallet.classicAddress, signingPublicKey: wallet.publicKey };
}
